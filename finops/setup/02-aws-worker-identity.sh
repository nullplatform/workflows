#!/usr/bin/env bash
# Gives the cloud-query WORKER POD its own read-only AWS identity (EKS Pod
# Identity) so the billing collector runs with NO credentials in workflows.
#
# What it does (idempotent, single account):
#   1. IAM role <ROLE> trusted by pods.eks.amazonaws.com, scoped to THIS cluster
#      (docs/iam/trust-pod-identity.json) + inline read-only policy
#      (docs/iam/np-finops-worker-policy.json).
#   2. ServiceAccount <SA> in the agent's worker namespace (NP_WORKER_NAMESPACE).
#   3. Pod Identity association cluster × namespace × SA → role.
#   4. Prints the NP_WORKER_RULES entry that makes the controlplane-agent spawn
#      the cloud-query image with that ServiceAccount (the agent env change is
#      NOT applied here — it is the operator's deployment; see the output).
#
# Requirements: aws CLI with admin-ish creds on the account (iam:CreateRole,
# iam:PutRolePolicy, eks:CreatePodIdentityAssociation), kubectl on the cluster,
# the eks-pod-identity-agent addon installed (`aws eks list-addons`).
#
# Usage:
#   ./02-aws-worker-identity.sh --cluster runtime [--region us-east-1] \
#       [--namespace np-workers] [--service-account np-finops-worker] \
#       [--role np-finops-worker] [--image-glob 'public.ecr.aws/nullplatform/*']
#
# Multi-account (the worker assumes a per-account role): run this ONCE on the
# cluster account with --assume-only, then create `np-finops` in each account
# with docs/iam/trust-cross-account.json + np-finops-worker-policy.json and put
# the ARNs in docs/iam/np-finops-worker-assume-policy.json.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IAM_DIR="$SCRIPT_DIR/../docs/iam"

CLUSTER=""; REGION="${AWS_REGION:-us-east-1}"; NAMESPACE="np-workers"
SA="np-finops-worker"; ROLE="np-finops-worker"
IMAGE_GLOB="public.ecr.aws/nullplatform/*"; ASSUME_ONLY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cluster) CLUSTER="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --namespace) NAMESPACE="$2"; shift 2 ;;
    --service-account) SA="$2"; shift 2 ;;
    --role) ROLE="$2"; shift 2 ;;
    --image-glob) IMAGE_GLOB="$2"; shift 2 ;;
    --assume-only) ASSUME_ONLY=true; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done
[[ -n "$CLUSTER" ]] || { echo "ERROR: --cluster is required" >&2; exit 1; }
command -v jq >/dev/null || { echo "ERROR: jq is required" >&2; exit 1; }

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
CLUSTER_ARN=$(aws eks describe-cluster --name "$CLUSTER" --region "$REGION" --query cluster.arn --output text)
echo "account=$ACCOUNT cluster=$CLUSTER_ARN namespace=$NAMESPACE sa=$SA role=$ROLE"

if ! aws eks list-addons --cluster-name "$CLUSTER" --region "$REGION" --output text | grep -q eks-pod-identity-agent; then
  echo "ERROR: addon eks-pod-identity-agent is not installed on $CLUSTER (install it, or use docs/iam/trust-irsa.json instead)" >&2
  exit 1
fi

# 1. Role (trust scoped to this cluster) + inline policy
TRUST=$(sed -e "s#<account>#$ACCOUNT#g" -e "s#<region>#$REGION#g" -e "s#<cluster-name>#$CLUSTER#g" "$IAM_DIR/trust-pod-identity.json")
if aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  echo "role $ROLE exists → updating trust policy"
  aws iam update-assume-role-policy --role-name "$ROLE" --policy-document "$TRUST"
else
  aws iam create-role --role-name "$ROLE" --assume-role-policy-document "$TRUST" \
    --description "nullplatform finops: read-only identity of the cloud-query worker pod" \
    --tags Key=managed-by,Value=nullplatform-finops >/dev/null
  echo "role $ROLE created"
fi
if [[ "$ASSUME_ONLY" == true ]]; then
  aws iam put-role-policy --role-name "$ROLE" --policy-name np-finops-assume \
    --policy-document "file://$IAM_DIR/np-finops-worker-assume-policy.json"
  echo "inline policy np-finops-assume attached (edit the account list in np-finops-worker-assume-policy.json first)"
else
  aws iam put-role-policy --role-name "$ROLE" --policy-name np-finops-read \
    --policy-document "file://$IAM_DIR/np-finops-worker-policy.json"
  echo "inline policy np-finops-read attached"
fi
ROLE_ARN=$(aws iam get-role --role-name "$ROLE" --query Role.Arn --output text)

# 2. ServiceAccount in the worker namespace
kubectl get ns "$NAMESPACE" >/dev/null 2>&1 || kubectl create ns "$NAMESPACE"
if ! kubectl -n "$NAMESPACE" get sa "$SA" >/dev/null 2>&1; then
  kubectl -n "$NAMESPACE" create sa "$SA"
  echo "serviceaccount $NAMESPACE/$SA created"
else
  echo "serviceaccount $NAMESPACE/$SA exists"
fi

# 3. Pod Identity association (one per cluster × ns × sa)
EXISTING=$(aws eks list-pod-identity-associations --cluster-name "$CLUSTER" --region "$REGION" \
  --namespace "$NAMESPACE" --service-account "$SA" --query 'associations[0].associationId' --output text)
if [[ -n "$EXISTING" && "$EXISTING" != "None" ]]; then
  aws eks update-pod-identity-association --cluster-name "$CLUSTER" --region "$REGION" \
    --association-id "$EXISTING" --role-arn "$ROLE_ARN" >/dev/null
  echo "pod identity association $EXISTING updated → $ROLE_ARN"
else
  aws eks create-pod-identity-association --cluster-name "$CLUSTER" --region "$REGION" \
    --namespace "$NAMESPACE" --service-account "$SA" --role-arn "$ROLE_ARN" >/dev/null
  echo "pod identity association created → $ROLE_ARN"
fi

# 4. Agent side: first matching rule wins; match on the image prefix so only the
#    cloud-query image gets this identity.
RULES=$(jq -cn --arg g "$IMAGE_GLOB" --arg sa "$SA" '[{match:{registry:$g},serviceAccount:$sa}]')
cat <<EOF

Done. Now tell the controlplane-agent to spawn the cloud-query worker with SA $SA.
Helm (chart nullplatform-agent):   worker.rules: $RULES
Env on the agent (NP_WORKER_*):    NP_WORKER_RULES='$RULES'
If the agent env lives in a Secret (envFrom), e.g.:
  kubectl -n <agent-ns> patch secret <agent-secret> --type=merge \\
    -p '{"data":{"NP_WORKER_RULES":"$(printf '%s' "$RULES" | base64)"}}'
  kubectl -n <agent-ns> rollout restart deploy/<agent-deployment>
Then run the identity probe: the worker must report arn:aws:sts::$ACCOUNT:assumed-role/$ROLE/...
EOF
