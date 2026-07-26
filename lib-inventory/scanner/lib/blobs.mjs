/** One GraphQL query aliasing every manifest blob at a commit — 1 request, cost 1. */
export function buildBlobQuery(owner, repo, ref, paths) {
  const aliases = paths
    .map(
      (p, i) =>
        `    f${i}: object(expression: ${JSON.stringify(`${ref}:${p}`)}) { ... on Blob { text } }`,
    )
    .join('\n');
  return (
    `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) {\n` +
    `${aliases}\n  } }`
  );
}

/** Map a GraphQL blob response back onto the manifest paths that produced it. */
export function readBlobResponse(manifests, result) {
  const node = result?.body?.data?.repository;
  const texts = {};
  if (!node) return texts;
  manifests.forEach((p, i) => {
    const t = node[`f${i}`]?.text;
    if (typeof t === 'string') texts[p] = t;
  });
  return texts;
}
