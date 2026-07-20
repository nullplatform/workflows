# AI Suggestions that render well in the UI

Hard-won rules for any workflow that creates action-item **suggestions**
(`np-action-item-suggestion-create`). Verified live against the
admin-dashboard `SuggestionCard` (2026-07-20) while wiring the
right-sizing accept flow — see `cost/wf2b-right-sizing-analyze-scope.yaml`
(`build_item` / `suggest_apply`) for the reference implementation.

## 1. ALWAYS seed `user_metadata` with the defaults

The **Execution Parameters** form only renders when `user_metadata` has
keys (`expanded && hasUserMetadata` in `SuggestionCard`). A perfect
`user_metadata_config` with an empty `user_metadata` shows **nothing** —
the user gets an Approve button with no options.

```yaml
config:
  userMetadata: "${{ steps.build_item.outputs.user_metadata_defaults }}"   # e.g. {deploy_timing: 'next-deploy', deploy_at: ''}
  userMetadataConfig: "${{ steps.build_item.outputs.user_metadata_config }}"
```

The human tweaks the seeded values before approving; the executor reads
the final answers from `user_metadata`. Keep every value **scalar and
flat** (string/number/boolean/null) — the API rejects nested values.

## 2. `user_metadata_config` is a JSON Schema — no wrappers

The UI feeds it **directly** to `DynamicForm` (JSONForms): it must be
`{type: 'object', properties: {...}}` at the **top level**. A
`{schema: {...}}` wrapper is silently ignored and the form degrades to an
auto-generated schema (no labels, no enums, no descriptions).

## 3. Human labels on enums: `oneOf` with `const` + `title`

JSONForms (`isOneOfEnumSchema`) renders the `title`, stores the `const` —
the executor keeps reading machine values:

```js
deploy_timing: {
  type: 'string',
  title: 'How to apply',
  oneOf: [
    { const: 'next-deploy', title: 'Apply only — ships with the next regular deploy' },
    { const: 'now',         title: 'Deploy now' },
    { const: 'scheduled',   title: 'Schedule the deploy (time below, or tonight\'s window)' }
  ],
  default: 'next-deploy'   // informational — the SEED is what pre-selects it
}
```

## 4. No `pattern` on optional fields you seed empty

Validation runs live: an empty-string seed that fails the `pattern`
leaves the form in an error state and blocks saving parameter changes.
Describe the expected format in `description` instead, and let the
executor tolerate/clamp bad input.

## 5. The suggestion `description` is MARKDOWN

The card renders it with ReactMarkdown. A run-on paragraph reads
terribly; structure it:

```
**Right-size Test** — CPU **500m → 50m**, memory **256MB → 256MB** · estimated saving **~53.83 USD/month**

**Execution plan**

1. `PATCH` the scope configuration via the platform API — **no deployment is triggered**.
2. The change ships with your next regular deployment; ...

**Your choice on approve** (Execution Parameters below): *apply only*, *deploy now*, or *schedule* it.
```

## 6. Inside `claude-code-agent` config, never reference `steps.*`

Not suggestion-specific but bitten twice the same day: agent-step config
strings resolve activity-side WITHOUT step state — every
`${{ steps.X.outputs.Y }}` arrives as the literal string `undefined`
(`vars.*` and `workflow.inputs.*` do resolve). Declare the values as step
`inputs:` and reference `${{ inputs.* }}` in prompts. And when you fix
that with a bulk replace, don't convert the freshly declared inputs into
self-references (`thread: "${{ inputs.thread }}"` resolves to nothing).
