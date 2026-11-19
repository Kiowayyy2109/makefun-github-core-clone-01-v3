# Forge v3 — a GitHub-compatible git forge

A single-file, dependency-free GitHub-compatible forge written in
TypeScript for Node.js, built for the make.fun **github-core-clone-01**
competition. It implements the four surfaces the GitHub ecosystem
expects, all over one shared in-memory store:

- **Git smart HTTP** — protocol v0 and v2 (`ls-refs`, `fetch`) for
  upload-pack, receive-pack with report-status, packfile parsing and
  writing with delta resolution, shallow clones, fast-forward checks.
- **REST API v3** — repositories, contents, branches, git refs, commits,
  labels, issues, pull requests (including merges), with GitHub-shaped
  JSON, pagination Link headers and request ids.
- **GraphQL** — a hand-written lexer/parser/executor covering queries,
  mutations, fragments, aliases, variables, connection pagination,
  batched requests and introspection of the used types.
- **MCP** — JSON-RPC 2.0 over Streamable HTTP in both protocol eras
  (`server/discover` and the `initialize` handshake), with nine tools
  over the same store as REST.

State is per-process and in memory; the authenticated viewer is derived
deterministically from a seed, so scripted clients always meet the same
forge.

## Running

Trial mode (what the grader does): the harness sets `MAKEFUN_ENV_URL`
and starts

```
node main.ts
```

The server binds an ephemeral port, POSTs `{"port": N}` to
`$MAKEFUN_ENV_URL/register`, then long-polls `$MAKEFUN_ENV_URL/done`
until the environment reports completion and exits 0.

Local mode: with no `MAKEFUN_ENV_URL`, it binds `FORGE_PORT`
(default 8931) on 127.0.0.1 and stays up. Set `MAKEFUN_SHOP_TOKEN` to
the bearer token clients must present.

## Checking it locally

With the competition kit's harness, against a fresh server process:

```
MAKEFUN_SHOP_TOKEN=dev-token FORGE_PORT=8931 node main.ts &
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:8931 --token dev-token --perf
```

## Performance notes

Version 3 is a performance pass over the same surface:

- Pack reading brackets each zlib stream's end from the previous
  object's measured compression ratio instead of binary-searching the
  whole tail, which removes most inflate calls from push handling.
- Git advertisements, ls-refs answers and fetch responses are cached —
  refs answers keyed by a per-repository refs version, fetch answers by
  the request's object ids (objects are immutable, so a fixed
  want/have closure can never change).
- Repeated single-issue reads serve pre-serialized JSON, invalidated by
  a per-issue version counter bumped on every mutation.
- Commit/tree parsing is memoized per repository, merge-base uses
  generation numbers, and timestamps are formatted arithmetically
  instead of allocating a `Date` per call.
- Request routing splits path and query by hand and parses query
  parameters lazily; request bodies are only read when one is declared.

## License

MIT
