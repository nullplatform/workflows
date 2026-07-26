// ------------------------------------------------------------- transport ---

/**
 * GitHub transport over REST (tree) + GraphQL (batched blobs).
 * One tree request plus one GraphQL request per ~60 manifests.
 */
export function makeGitHubTransport(token, fetchImpl = fetch) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'np-lib-inventory',
  };

  async function tree(owner, repo, ref) {
    const refs = [ref, 'main', 'master'].filter(Boolean);
    let lastErr = 'no ref tried';
    for (const r of refs) {
      const res = await fetchImpl(
        `https://api.github.com/repos/${owner}/${repo}/git/trees/${r}?recursive=1`,
        { headers },
      );
      if (res.status === 200) {
        const body = await res.json();
        if (body.truncated) {
          throw new Error(`tree for ${owner}/${repo}@${r} is truncated (>100k entries)`);
        }
        return body.tree.filter((n) => n.type === 'blob').map((n) => n.path);
      }
      lastErr = `HTTP ${res.status}`;
      if (res.status === 401 || res.status === 403) break; // auth problems will not fix themselves
    }
    throw new Error(lastErr);
  }

  async function blobs(owner, repo, ref, paths) {
    const out = {};
    for (let i = 0; i < paths.length; i += 60) {
      const chunk = paths.slice(i, i + 60);
      const aliases = chunk
        .map(
          (p, j) =>
            `    f${j}: object(expression: ${JSON.stringify(`${ref}:${p}`)}) { ... on Blob { text } }`,
        )
        .join('\n');
      const query = `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) {\n${aliases}\n} }`;
      const res = await fetchImpl('https://api.github.com/graphql', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      if (res.status !== 200) throw new Error(`graphql HTTP ${res.status}`);
      const body = await res.json();
      if (body.errors?.length) throw new Error(`graphql: ${body.errors[0].message}`);
      const repoNode = body.data?.repository;
      if (!repoNode) throw new Error('graphql: repository not visible to this token');
      chunk.forEach((p, j) => {
        const node = repoNode[`f${j}`];
        if (node && typeof node.text === 'string') out[p] = node.text;
      });
    }
    return out;
  }

  return { tree, blobs };
}
