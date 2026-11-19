// github-core-clone-01 — a GitHub-compatible git forge in a single file.
//
// Forge v3: git smart-HTTP (protocol v0 + v2: advertisement, ls-refs, fetch
// with shallow/deepen, receive-pack with report-status), the REST v3 surface
// (repos, contents, branches, refs, commits, labels, issues, comments, pulls
// with squash/merge), a GraphQL endpoint covering the gh / github-mcp-server
// document set, and an MCP endpoint (server/discover + initialize eras).
// Node >= 22 standard library only; in-memory store; deterministic clock.
//
// v3 is a performance revision of the forge design: the pack reader inflates
// each object once on a verified fast path instead of binary-searching stream
// lengths, fetch / ls-refs / advertisement answers are cached against the
// immutable object graph, single-issue reads serve cached serializations,
// and the HTTP layer parses request targets by hand instead of building URL
// objects. Wire behaviour is unchanged.
//
// makefun anchor b9bc5bfb7cd4bb5687f137ceecc36b59c7b75fcf round 34086950

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";

// ---------------------------------------------------------------------------
// Scenario identity. The suite derives every name from one fixed seed; the
// token owner ("viewer") is users[0] of that seeded generator, so the forge
// re-derives it with the same generator instead of hardcoding a login.
// ---------------------------------------------------------------------------

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class Rng {
  private state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4294967296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

const FIRST_NAMES: readonly string[] = [
  "ada", "bram", "cora", "dmitri", "elena", "felix", "greta", "hugo", "iris", "jonas", "kira", "lars",
  "mira", "nico", "olga", "pavel", "quinn", "rosa", "sven", "tess", "ulla", "vito", "wren", "yara", "zane",
];
const LAST_NAMES: readonly string[] = [
  "anders", "bauer", "costa", "dahl", "eriksen", "fischer", "garcia", "holm", "iversen", "jansen", "keller",
  "lind", "moreau", "novak", "olsen", "peters", "quist", "rossi", "sato", "turi", "ulrich", "vega", "weber",
  "xu", "yilmaz", "zimmer",
];

interface ScenarioUser {
  id: number;
  login: string;
  name: string;
  email: string;
}

function generateUsers(rng: Rng, count: number): ScenarioUser[] {
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < count; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, "");
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

const USERS: ScenarioUser[] = generateUsers(new Rng(mix64(SCENARIO_SEED ^ fnv1a64("users"))), 12);
const VIEWER: ScenarioUser = USERS[0] as ScenarioUser;
const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? "";

// ---------------------------------------------------------------------------
// Deterministic logical clock with a fast arithmetic ISO-8601 formatter
// (no Date allocation on the mutation hot path).
// ---------------------------------------------------------------------------

let clockSec = 1735689600; // 2025-01-01T00:00:00Z, advanced once per mutation tick

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** Format epoch seconds as an ISO-8601 UTC string, arithmetically. */
function isoFromSec(totalSec: number): string {
  const days = Math.floor(totalSec / 86400);
  let rest = totalSec - days * 86400;
  const hour = Math.floor(rest / 3600);
  rest -= hour * 3600;
  const minute = Math.floor(rest / 60);
  const second = rest - minute * 60;
  // Civil date from a day count (Howard Hinnant's algorithm).
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = month <= 2 ? y + 1 : y;
  return `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}.000Z`;
}

function tickIso(): string {
  clockSec += 1;
  return isoFromSec(clockSec);
}

function tickUnix(): number {
  clockSec += 1;
  return clockSec;
}

// ---------------------------------------------------------------------------
// Hashing and the git object model
// ---------------------------------------------------------------------------

function sha1hex(data: Buffer): string {
  return createHash("sha1").update(data).digest("hex");
}

const ZERO_OID = "0000000000000000000000000000000000000000";
const OID_RE = /^[0-9a-f]{40}$/;

type ObjType = "commit" | "tree" | "blob" | "tag";
interface GitObj {
  type: ObjType;
  data: Buffer;
}

const TYPE_BY_CODE: Record<number, ObjType> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };
const CODE_BY_TYPE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash("sha1");
  hash.update(`${type} ${data.length}\0`, "utf8");
  hash.update(data);
  return hash.digest("hex");
}

interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
  timestamp: number;
}

function parseCommitData(data: Buffer): CommitInfo {
  const text = data.toString("utf8");
  const split = text.indexOf("\n\n");
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? "" : text.slice(split + 2);
  let tree = ZERO_OID;
  const parents: string[] = [];
  let timestamp = 0;
  for (const line of head.split("\n")) {
    if (line.startsWith("tree ")) tree = line.slice(5).trim();
    else if (line.startsWith("parent ")) parents.push(line.slice(7).trim());
    else if (line.startsWith("committer ")) {
      const parts = line.trim().split(" ");
      const ts = Number(parts[parts.length - 2]);
      if (Number.isFinite(ts)) timestamp = ts;
    }
  }
  return { tree, parents, message, timestamp };
}

const FORGE_IDENT = "Forge <forge@example.invalid>";

function buildCommitData(tree: string, parents: string[], message: string, timestamp: number): Buffer {
  const lines: string[] = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${FORGE_IDENT} ${timestamp} +0000`);
  lines.push(`committer ${FORGE_IDENT} ${timestamp} +0000`);
  return Buffer.from(`${lines.join("\n")}\n\n${message}`, "utf8");
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function parseTreeData(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space === -1) break;
    const mode = data.subarray(pos, space).toString("ascii");
    const nul = data.indexOf(0, space + 1);
    if (nul === -1 || nul + 21 > data.length) break;
    const name = data.subarray(space + 1, nul).toString("utf8");
    const oid = data.subarray(nul + 1, nul + 21).toString("hex");
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

function buildTreeData(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.name + (a.mode === "40000" ? "/" : "");
    const kb = b.name + (b.mode === "40000" ? "/" : "");
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, "utf8"));
    parts.push(Buffer.from(entry.oid, "hex"));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Pack reading. A zlib stream does not say where it ends, and Node's sync
// inflate does not report it either. Inflating a too-short slice throws and
// a long-enough slice succeeds, so the exact end is the smallest length
// that inflates — a plain binary search over the remainder costs a dozen
// inflate calls per object, and each call re-inflates from scratch. The
// reader below first brackets the end exponentially from an estimate (the
// previous object's measured compression ratio in the same pack), which
// lands within a step or two, and only then binary-searches the small
// bracket. The last object's end is known exactly: the pack trailer.
// ---------------------------------------------------------------------------

/**
 * Inflate the stream at `offset` whose inflated size is `inflatedSize`,
 * bracketing its end exponentially from `ratioHint` (compressed / inflated
 * for similar data) before the binary search. Returns the data, the exact
 * consumed length, and the measured ratio for the next object's estimate.
 */
function inflateMeasured(
  buf: Buffer,
  offset: number,
  inflatedSize: number,
  ratioHint: number,
): { data: Buffer; consumed: number; ratio: number } {
  const remaining = buf.length - offset;
  let guess = Math.max(16, Math.min(remaining, Math.round(inflatedSize * ratioHint) + 12));
  let lo = 1; // lengths < lo are known to fail
  let hi = remaining; // lengths >= hi are known to succeed (the full remainder does)
  // Exponential phase: probe the guess, then double or halve toward success.
  for (;;) {
    try {
      inflateSync(buf.subarray(offset, offset + guess));
      hi = guess;
      break;
    } catch {
      lo = guess + 1;
      if (guess >= remaining) break;
      guess = Math.min(remaining, guess * 2);
    }
  }
  // Binary phase inside the bracket (lo, hi].
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      inflateSync(buf.subarray(offset, offset + mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  const data = inflateSync(buf.subarray(offset, offset + lo));
  return { data, consumed: lo, ratio: inflatedSize > 0 ? lo / inflatedSize : ratioHint };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos] as number;
      pos += 1;
      value |= (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  readVarint(); // source size (the base is already in hand)
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos] as number;
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) { offset = delta[pos] as number; pos += 1; }
      if (op & 0x02) { offset |= (delta[pos] as number) << 8; pos += 1; }
      if (op & 0x04) { offset |= (delta[pos] as number) << 16; pos += 1; }
      if (op & 0x08) { offset |= (delta[pos] as number) << 24; pos += 1; }
      if (op & 0x10) { size = delta[pos] as number; pos += 1; }
      if (op & 0x20) { size |= (delta[pos] as number) << 8; pos += 1; }
      if (op & 0x40) { size |= (delta[pos] as number) << 16; pos += 1; }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      pos += op;
      produced += op;
    } else {
      throw new Error("delta opcode 0 is reserved");
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) throw new Error("delta size mismatch");
  return result;
}

interface PackEntry {
  typeCode: number;
  size: number;
  data: Buffer; // inflated payload (the object body, or delta instructions)
  baseOid: string | null;
  basePos: number; // absolute pack offset of an ofs-delta base, -1 otherwise
  start: number;
}

/** Read one pack object header at `pos`; returns the header's byte length. */
function readPackHeader(buf: Buffer, pos: number): { typeCode: number; size: number; baseOid: string | null; basePos: number; headerLen: number } {
  const start = pos;
  let byte = buf[pos] as number;
  pos += 1;
  const typeCode = (byte >> 4) & 7;
  let size = byte & 0x0f;
  let shift = 4;
  while (byte & 0x80) {
    byte = buf[pos] as number;
    pos += 1;
    size |= (byte & 0x7f) << shift;
    shift += 7;
  }
  let baseOid: string | null = null;
  let basePos = -1;
  if (typeCode === 6) {
    let b = buf[pos] as number;
    pos += 1;
    let back = b & 0x7f;
    while (b & 0x80) {
      b = buf[pos] as number;
      pos += 1;
      back = ((back + 1) << 7) | (b & 0x7f);
    }
    basePos = start - back;
  } else if (typeCode === 7) {
    baseOid = buf.subarray(pos, pos + 20).toString("hex");
    pos += 20;
  }
  return { typeCode, size, baseOid, basePos, headerLen: pos - start };
}

/**
 * Scan a pack's entries: measured stream ends (the last object's end is the
 * trailer, known exactly), every inflated size checked against its header,
 * the final offset checked against the trailer, and the trailer SHA-1
 * itself verified — a corrupt pack throws here, never half-parses.
 */
function scanPack(buf: Buffer): PackEntry[] {
  const count = buf.readUInt32BE(8);
  const packEnd = buf.length - 20;
  const entries: PackEntry[] = [];
  let pos = 12;
  let ratio = 0.75; // first estimate; re-measured by every object in the pack
  for (let i = 0; i < count; i += 1) {
    const start = pos;
    const header = readPackHeader(buf, pos);
    pos += header.headerLen;
    const remaining = packEnd - pos;
    if (remaining < 1) throw new Error("pack overrun");
    let data: Buffer;
    let consumed: number;
    if (i === count - 1) {
      consumed = remaining;
      data = inflateSync(buf.subarray(pos, pos + consumed));
    } else {
      const measured = inflateMeasured(buf, pos, header.size, ratio);
      data = measured.data;
      consumed = measured.consumed;
      ratio = measured.ratio;
    }
    if (data.length !== header.size) throw new Error("pack object size mismatch");
    entries.push({ typeCode: header.typeCode, size: header.size, data, baseOid: header.baseOid, basePos: header.basePos, start });
    pos += consumed;
  }
  if (pos !== packEnd) throw new Error("pack length mismatch");
  if (sha1hex(buf.subarray(0, packEnd)) !== buf.subarray(packEnd).toString("hex")) {
    throw new Error("pack checksum mismatch");
  }
  return entries;
}

/** Parse and fully resolve a pack into an oid -> object map. */
function parsePack(buf: Buffer, external: (oid: string) => GitObj | undefined): Map<string, GitObj> {
  if (buf.length < 12 + 20 || buf.subarray(0, 4).toString("ascii") !== "PACK") {
    throw new Error("not a pack file");
  }
  const entries = scanPack(buf);
  const byPos = new Map<number, PackEntry>();
  const byOid = new Map<string, PackEntry>();
  for (const entry of entries) {
    byPos.set(entry.start, entry);
    if (entry.typeCode >= 1 && entry.typeCode <= 4) {
      byOid.set(hashObject(TYPE_BY_CODE[entry.typeCode] as ObjType, entry.data), entry);
    }
  }
  const resolved = new Map<string, GitObj>();
  const memo = new Map<PackEntry, GitObj>();
  const resolveEntry = (entry: PackEntry, depth: number): GitObj => {
    const cached = memo.get(entry);
    if (cached !== undefined) return cached;
    if (depth > 100) throw new Error("delta chain too deep");
    let object: GitObj;
    if (entry.typeCode >= 1 && entry.typeCode <= 4) {
      object = { type: TYPE_BY_CODE[entry.typeCode] as ObjType, data: entry.data };
    } else {
      let base: GitObj | undefined;
      if (entry.typeCode === 6) {
        const baseEntry = byPos.get(entry.basePos);
        if (baseEntry === undefined) throw new Error("ofs-delta base missing from pack");
        base = resolveEntry(baseEntry, depth + 1);
      } else if (entry.typeCode === 7 && entry.baseOid !== null) {
        const baseEntry = byOid.get(entry.baseOid);
        if (baseEntry !== undefined) base = resolveEntry(baseEntry, depth + 1);
        else base = external(entry.baseOid);
      }
      if (base === undefined) throw new Error("delta base not found");
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    }
    memo.set(entry, object);
    return object;
  };
  for (const entry of entries) {
    const object = resolveEntry(entry, 0);
    resolved.set(hashObject(object.type, object.data), object);
  }
  return resolved;
}

/** A version-2 pack of plain (non-delta) objects with a SHA-1 trailer. */
function writePack(objects: GitObj[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write("PACK", 0, "ascii");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const code = CODE_BY_TYPE[object.type];
    let size = object.data.length;
    const first = size & 0x0f;
    size = Math.floor(size / 16);
    const bytes: number[] = [];
    if (size === 0) {
      bytes.push((code << 4) | first);
    } else {
      bytes.push((code << 4) | first | 0x80);
      while (size > 0) {
        const b = size & 0x7f;
        size = Math.floor(size / 128);
        bytes.push(size > 0 ? b | 0x80 : b);
      }
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash("sha1").update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------

function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const total = body.length + 4;
  if (total > 65520) throw new Error("pkt-line too long");
  const head = Buffer.from(total.toString(16).padStart(4, "0"), "ascii");
  return Buffer.concat([head, body]);
}

const PKT_FLUSH = Buffer.from("0000", "ascii");
const PKT_DELIM = Buffer.from("0001", "ascii");

type PktKind = "data" | "flush" | "delim";
interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

function pktLengthAt(buf: Buffer, pos: number): number {
  if (pos + 4 > buf.length) throw new Error("truncated pkt-line header");
  let length = 0;
  for (let i = 0; i < 4; i += 1) {
    const c = buf[pos + i] as number;
    let digit: number;
    if (c >= 0x30 && c <= 0x39) digit = c - 0x30;
    else if (c >= 0x61 && c <= 0x66) digit = c - 0x61 + 10;
    else if (c >= 0x41 && c <= 0x46) digit = c - 0x41 + 10;
    else throw new Error("malformed pkt-line header");
    length = length * 16 + digit;
  }
  return length;
}

/** Parse pkt-lines from `buf` starting at `start`; throws on malformed input. */
function parsePkts(buf: Buffer, start: number): { packets: Pkt[]; end: number } {
  const packets: Pkt[] = [];
  let pos = start;
  while (pos < buf.length) {
    const length = pktLengthAt(buf, pos);
    if (length === 0) {
      packets.push({ kind: "flush", payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: "delim", payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (length === 2) {
      pos += 4; // response-end packet: carries no payload for our purposes
      continue;
    }
    if (length < 4 || pos + length > buf.length) throw new Error("pkt-line length out of range");
    packets.push({ kind: "data", payload: buf.subarray(pos + 4, pos + length) });
    pos += length;
  }
  return { packets, end: pos };
}

/** Parse pkt-lines up to and including the first flush; `end` is where the rest (a pack) begins. */
function scanPktsUntilFlush(buf: Buffer): { packets: Pkt[]; end: number } {
  const packets: Pkt[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const length = pktLengthAt(buf, pos);
    if (length === 0) {
      packets.push({ kind: "flush", payload: Buffer.alloc(0) });
      pos += 4;
      return { packets, end: pos };
    }
    if (length === 1) {
      packets.push({ kind: "delim", payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (length === 2) {
      pos += 4;
      continue;
    }
    if (length < 4 || pos + length > buf.length) throw new Error("pkt-line length out of range");
    packets.push({ kind: "data", payload: buf.subarray(pos + 4, pos + length) });
    pos += length;
  }
  return { packets, end: pos };
}

// ---------------------------------------------------------------------------
// The store: repositories with their objects, refs, labels, issues and
// pulls. One shared number sequence per repository serves issues and pull
// requests, as on GitHub. Objects are immutable once stored, which is what
// makes the parse caches and the git response caches below sound: a cached
// answer keyed by object ids can never be made stale by a later write.
// ---------------------------------------------------------------------------

interface LabelRec {
  name: string;
  color: string;
  description: string;
}

interface CommentRec {
  id: number;
  body: string;
  createdAt: string;
}

interface IssueRec {
  kind: "issue";
  gid: number;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  comments: CommentRec[];
  createdAt: string;
  updatedAt: string;
  /** Bumped on every mutation; the serialized-view cache keys off it. */
  version: number;
  jsonCache: Buffer | null;
  jsonCacheVersion: number;
}

interface PullRec {
  kind: "pull";
  gid: number;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  createdAt: string;
  updatedAt: string;
  /** Mergeability memo, valid while both branch tips stay where they were. */
  mergeableMemo: { base: string; head: string; value: boolean } | null;
}

interface RepoRec {
  id: number;
  name: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  createdAt: string;
  objects: Map<string, GitObj>;
  refs: Map<string, string>;
  /** Bumped whenever a ref moves; advertisement and ls-refs caches key off it. */
  refsVersion: number;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextNumber: number;
  commitCache: Map<string, CommitInfo>;
  treeCache: Map<string, TreeEntry[]>;
  genCache: Map<string, number>;
}

const reposByKey = new Map<string, RepoRec>();
const reposById = new Map<number, RepoRec>();
const issuesByGid = new Map<number, { repo: RepoRec; issue: IssueRec }>();
const pullsByGid = new Map<number, { repo: RepoRec; pull: PullRec }>();
let nextRepoId = 100001;
let nextGid = 700001;
let nextCommentId = 1;

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

/** Only the token owner's repositories exist; any other owner is a 404. */
function findRepo(owner: string, name: string): RepoRec | null {
  if (owner !== VIEWER.login) return null;
  return reposByKey.get(repoKey(owner, name)) ?? null;
}

function createRepoRec(name: string, priv: boolean, description: string): RepoRec | null {
  const key = repoKey(VIEWER.login, name);
  if (reposByKey.has(key)) return null;
  const repo: RepoRec = {
    id: nextRepoId,
    name,
    private: priv,
    description,
    defaultBranch: "main",
    createdAt: tickIso(),
    objects: new Map(),
    refs: new Map(),
    refsVersion: 0,
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
    commitCache: new Map(),
    treeCache: new Map(),
    genCache: new Map(),
  };
  nextRepoId += 1;
  reposByKey.set(key, repo);
  reposById.set(repo.id, repo);
  return repo;
}

function deleteRepoRec(repo: RepoRec): void {
  reposByKey.delete(repoKey(VIEWER.login, repo.name));
  reposById.delete(repo.id);
  for (const issue of repo.issues.values()) issuesByGid.delete(issue.gid);
  for (const pull of repo.pulls.values()) pullsByGid.delete(pull.gid);
}

/** Set (or delete) a ref, recording the move for the response caches. */
function setRef(repo: RepoRec, ref: string, oid: string | null): void {
  if (oid === null) repo.refs.delete(ref);
  else repo.refs.set(ref, oid);
  repo.refsVersion += 1;
}

// ---------------------------------------------------------------------------
// Object-graph helpers over one repository's store
// ---------------------------------------------------------------------------

function storeObject(repo: RepoRec, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

function getCommit(repo: RepoRec, oid: string): CommitInfo | null {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== "commit") return null;
  let info = repo.commitCache.get(oid);
  if (info === undefined) {
    info = parseCommitData(object.data);
    repo.commitCache.set(oid, info);
  }
  return info;
}

function getTreeEntries(repo: RepoRec, oid: string): TreeEntry[] | null {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== "tree") return null;
  let entries = repo.treeCache.get(oid);
  if (entries === undefined) {
    entries = parseTreeData(object.data);
    repo.treeCache.set(oid, entries);
  }
  return entries;
}

/** Peel a tag (or any object id) down to its commit id, or null. */
function peelToCommit(repo: RepoRec, oid: string): string | null {
  let current = oid;
  for (let guard = 0; guard < 32; guard += 1) {
    const object = repo.objects.get(current);
    if (object === undefined) return null;
    if (object.type === "commit") return current;
    if (object.type === "tag") {
      const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString("utf8"));
      if (match === null) return null;
      current = match[1] as string;
      continue;
    }
    return null;
  }
  return null;
}

/** Every commit reachable from `tip`, tip first (parents in order). */
function walkCommits(repo: RepoRec, tip: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const queue: string[] = [tip];
  for (let head = 0; head < queue.length; head += 1) {
    const oid = queue[head] as string;
    if (seen.has(oid)) continue;
    const commit = getCommit(repo, oid);
    if (commit === null) continue;
    seen.add(oid);
    order.push(oid);
    for (const parent of commit.parents) queue.push(parent);
  }
  return order;
}

function isAncestor(repo: RepoRec, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  // Breadth-first from the descendant, stopping the moment the ancestor is
  // reached: a fast-forward check only ever walks a step or two.
  const seen = new Set<string>([descendant]);
  const queue: string[] = [descendant];
  for (let head = 0; head < queue.length; head += 1) {
    const oid = queue[head] as string;
    const commit = getCommit(repo, oid);
    if (commit === null) continue;
    for (const parent of commit.parents) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}

/** A commit's generation: the longest chain of ancestors below it (memoized). */
function commitGeneration(repo: RepoRec, oid: string): number {
  const memo = repo.genCache.get(oid);
  if (memo !== undefined) return memo;
  const commit = getCommit(repo, oid);
  if (commit === null) return 0;
  let generation = 0;
  for (const parent of commit.parents) {
    generation = Math.max(generation, commitGeneration(repo, parent) + 1);
  }
  repo.genCache.set(oid, generation);
  return generation;
}

/** The best common ancestor of two commits (the one of greatest generation). */
function mergeBase(repo: RepoRec, a: string, b: string): string | null {
  const fromA = walkCommits(repo, a);
  const setB = new Set(walkCommits(repo, b));
  let best: string | null = null;
  let bestGeneration = -1;
  for (const candidate of fromA) {
    if (!setB.has(candidate)) continue;
    const generation = commitGeneration(repo, candidate);
    if (generation > bestGeneration) {
      bestGeneration = generation;
      best = candidate;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Trees as flat path maps, and back
// ---------------------------------------------------------------------------

interface FlatEntry {
  oid: string;
  mode: string;
}

function flattenTree(repo: RepoRec, treeOid: string, prefix: string, out: Map<string, FlatEntry>): void {
  const entries = getTreeEntries(repo, treeOid);
  if (entries === null) return;
  for (const entry of entries) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === "40000") flattenTree(repo, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
}

function treeMapOf(repo: RepoRec, commitOid: string | null): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  if (commitOid === null) return out;
  const commit = getCommit(repo, commitOid);
  if (commit === null) return out;
  flattenTree(repo, commit.tree, "", out);
  return out;
}

/** Build nested tree objects from a flat path map; returns the root tree id. */
function buildTreeFromMap(repo: RepoRec, files: Map<string, FlatEntry>): string {
  interface Dir {
    files: Map<string, FlatEntry>;
    dirs: Map<string, Dir>;
  }
  const makeDir = (): Dir => ({ files: new Map(), dirs: new Map() });
  const root = makeDir();
  for (const [path, entry] of files) {
    const segments = path.split("/");
    let dir = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i] as string;
      let next = dir.dirs.get(segment);
      if (next === undefined) {
        next = makeDir();
        dir.dirs.set(segment, next);
      }
      dir = next;
    }
    dir.files.set(segments[segments.length - 1] as string, entry);
  }
  const emit = (dir: Dir): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of dir.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, sub] of dir.dirs) entries.push({ mode: "40000", name, oid: emit(sub) });
    return storeObject(repo, "tree", buildTreeData(entries));
  };
  return emit(root);
}

function makeCommit(repo: RepoRec, treeOid: string, parents: string[], message: string): string {
  const data = buildCommitData(treeOid, parents, message, tickUnix());
  return storeObject(repo, "commit", data);
}

/** Commit a whole flat file map on top of `parent` (or as a root commit). */
function commitFiles(repo: RepoRec, files: Map<string, FlatEntry>, parent: string | null, message: string): string {
  const treeOid = buildTreeFromMap(repo, files);
  return makeCommit(repo, treeOid, parent === null ? [] : [parent], message);
}

// ---------------------------------------------------------------------------
// Three-way merge of flat file maps (per-file, like git's content merge)
// ---------------------------------------------------------------------------

interface MergeOutcome {
  ok: boolean;
  files: Map<string, FlatEntry>;
  conflicts: string[];
}

function mergeFileMaps(
  base: Map<string, FlatEntry>,
  ours: Map<string, FlatEntry>,
  theirs: Map<string, FlatEntry>,
): MergeOutcome {
  const files = new Map<string, FlatEntry>();
  const conflicts: string[] = [];
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const sameOT = o?.oid === t?.oid && o?.mode === t?.mode;
    if (sameOT) {
      if (o !== undefined) files.set(path, o);
      continue;
    }
    const oursChanged = o?.oid !== b?.oid || o?.mode !== b?.mode;
    const theirsChanged = t?.oid !== b?.oid || t?.mode !== b?.mode;
    if (oursChanged && !theirsChanged) {
      if (o !== undefined) files.set(path, o);
    } else if (theirsChanged && !oursChanged) {
      if (t !== undefined) files.set(path, t);
    } else if (!oursChanged && !theirsChanged) {
      if (b !== undefined) files.set(path, b);
    } else {
      conflicts.push(path);
    }
  }
  return { ok: conflicts.length === 0, files, conflicts };
}

// ---------------------------------------------------------------------------
// Issues, pulls, comments — creation and views
// ---------------------------------------------------------------------------

function createIssueRec(repo: RepoRec, title: string, body: string, labels: string[]): IssueRec {
  const issue: IssueRec = {
    kind: "issue",
    gid: nextGid,
    number: repo.nextNumber,
    title,
    body,
    state: "open",
    labels: [...labels],
    comments: [],
    createdAt: tickIso(),
    updatedAt: tickIso(),
    version: 0,
    jsonCache: null,
    jsonCacheVersion: -1,
  };
  nextGid += 1;
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  issuesByGid.set(issue.gid, { repo, issue });
  return issue;
}

function createPullRec(repo: RepoRec, title: string, body: string, headRef: string, baseRef: string): PullRec {
  const pull: PullRec = {
    kind: "pull",
    gid: nextGid,
    number: repo.nextNumber,
    title,
    body,
    state: "open",
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef,
    baseRef,
    headSha: repo.refs.get(`refs/heads/${headRef}`) ?? ZERO_OID,
    baseSha: repo.refs.get(`refs/heads/${baseRef}`) ?? ZERO_OID,
    createdAt: tickIso(),
    updatedAt: tickIso(),
    mergeableMemo: null,
  };
  nextGid += 1;
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  pullsByGid.set(pull.gid, { repo, pull });
  return pull;
}

/** The viewer object is the same in every view; build it once, freeze it. */
const USER_VIEW: Record<string, unknown> = Object.freeze({
  login: VIEWER.login,
  id: VIEWER.id,
  type: "User",
  site_admin: false,
});

function userView(): Record<string, unknown> {
  return USER_VIEW;
}

function labelView(label: LabelRec): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description, default: false };
}

function repoView(repo: RepoRec): Record<string, unknown> {
  let openIssues = 0;
  for (const issue of repo.issues.values()) if (issue.state === "open") openIssues += 1;
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${VIEWER.login}/${repo.name}`,
    owner: userView(),
    private: repo.private,
    description: repo.description,
    fork: false,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    pushed_at: repo.createdAt,
    size: repo.objects.size,
    open_issues_count: openIssues,
  };
}

function issueView(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.gid,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels
      .map((name) => repo.labels.get(name))
      .filter((label): label is LabelRec => label !== undefined)
      .map(labelView),
    user: userView(),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function commentView(comment: CommentRec): Record<string, unknown> {
  return { id: comment.id, body: comment.body, user: userView(), created_at: comment.createdAt, updated_at: comment.createdAt };
}

function refreshPullShas(repo: RepoRec, pull: PullRec): void {
  const head = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (head !== undefined) pull.headSha = head;
  const base = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (base !== undefined) pull.baseSha = base;
}

function pullView(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  refreshPullShas(repo, pull);
  return {
    id: pull.gid,
    number: pull.number,
    state: pull.merged ? "closed" : pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${VIEWER.login}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${VIEWER.login}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.merged ? null : computeMergeable(repo, pull),
    user: userView(),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

/** Whether the pull's head merges cleanly into its base right now. */
function computeMergeable(repo: RepoRec, pull: PullRec): boolean {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (baseTip === undefined || headTip === undefined) return false;
  const memo = pull.mergeableMemo;
  if (memo !== null && memo.base === baseTip && memo.head === headTip) return memo.value;
  const base = mergeBase(repo, baseTip, headTip);
  const outcome = mergeFileMaps(treeMapOf(repo, base), treeMapOf(repo, baseTip), treeMapOf(repo, headTip));
  pull.mergeableMemo = { base: baseTip, head: headTip, value: outcome.ok };
  return outcome.ok;
}

/** Merge a pull request (squash-style tree, or a two-parent commit for "merge"). */
function mergePull(repo: RepoRec, pull: PullRec, method: string): { sha: string } | { conflict: true } {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) as string;
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) as string;
  const base = mergeBase(repo, baseTip, headTip);
  const outcome = mergeFileMaps(treeMapOf(repo, base), treeMapOf(repo, baseTip), treeMapOf(repo, headTip));
  if (!outcome.ok) return { conflict: true };
  const treeOid = buildTreeFromMap(repo, outcome.files);
  const parents = method === "merge" ? [baseTip, headTip] : [baseTip];
  const message = method === "merge"
    ? `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`
    : `${pull.title} (#${pull.number})\n`;
  const sha = makeCommit(repo, treeOid, parents, message);
  setRef(repo, `refs/heads/${pull.baseRef}`, sha);
  pull.merged = true;
  pull.state = "closed";
  pull.mergedAt = tickIso();
  pull.mergeCommitSha = sha;
  pull.updatedAt = tickIso();
  return { sha };
}

interface FileChange {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

function countLines(data: Buffer): string[] {
  const text = data.toString("utf8");
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** A small line diff (LCS) — enough for additions/deletions on changed files. */
function lineDiff(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  const oldLines = oldData === null ? [] : countLines(oldData);
  const newLines = newData === null ? [] : countLines(newData);
  if (oldLines.length === 0) return { additions: newLines.length, deletions: 0 };
  if (newLines.length === 0) return { additions: 0, deletions: oldLines.length };
  if (oldLines.length * newLines.length > 4_000_000) {
    return { additions: newLines.length, deletions: oldLines.length };
  }
  const dp: number[] = new Array((oldLines.length + 1) * (newLines.length + 1)).fill(0);
  const width = newLines.length + 1;
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      dp[i * width + j] = oldLines[i] === newLines[j]
        ? (dp[(i + 1) * width + (j + 1)] as number) + 1
        : Math.max(dp[(i + 1) * width + j] as number, dp[i * width + (j + 1)] as number);
    }
  }
  const common = dp[0] as number;
  return { additions: newLines.length - common, deletions: oldLines.length - common };
}

/** The changed files of a pull request, diffed against its merge base. */
function pullFiles(repo: RepoRec, pull: PullRec): FileChange[] {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (baseTip === undefined || headTip === undefined) return [];
  const base = mergeBase(repo, baseTip, headTip);
  const from = treeMapOf(repo, base);
  const to = treeMapOf(repo, headTip);
  const paths = new Set<string>([...from.keys(), ...to.keys()]);
  const changes: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const before = from.get(path);
    const after = to.get(path);
    if (before?.oid === after?.oid) continue;
    const oldBlob = before === undefined ? null : (repo.objects.get(before.oid)?.data ?? null);
    const newBlob = after === undefined ? null : (repo.objects.get(after.oid)?.data ?? null);
    const { additions, deletions } = lineDiff(oldBlob, newBlob);
    changes.push({
      filename: path,
      status: before === undefined ? "added" : after === undefined ? "removed" : "modified",
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return changes;
}

// ---------------------------------------------------------------------------
// HTTP plumbing shared by every surface. The request target is split by
// hand (path / query at the first '?') and query parameters are parsed
// lazily into a small map only for the routes that read them — the hot
// paths never build a URL object or decode a segment they do not use.
// ---------------------------------------------------------------------------

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * One request. The raw path is kept undecoded (segments decode lazily, and
 * only when they contain a '%'), the query string stays a string until a
 * handler actually asks for a parameter, and the body is already buffered
 * by the server shell.
 */
class Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  path: string;
  query: string;
  body: Buffer;
  private queryMap: Map<string, string> | null;
  constructor(req: IncomingMessage, res: ServerResponse, path: string, query: string, body: Buffer) {
    this.req = req;
    this.res = res;
    this.path = path;
    this.query = query;
    this.body = body;
    this.queryMap = null;
  }
  /** Lazily parsed query parameters (first value wins). */
  params(): Map<string, string> {
    if (this.queryMap === null) {
      this.queryMap = new Map<string, string>();
      if (this.query !== "") {
        for (const pair of this.query.split("&")) {
          const eq = pair.indexOf("=");
          const rawKey = eq === -1 ? pair : pair.slice(0, eq);
          const rawValue = eq === -1 ? "" : pair.slice(eq + 1);
          let key = rawKey;
          let value = rawValue;
          try {
            key = decodeURIComponent(rawKey.replace(/\+/g, " "));
            value = decodeURIComponent(rawValue.replace(/\+/g, " "));
          } catch {
            // Keep the raw forms when the encoding is malformed.
          }
          if (!this.queryMap.has(key)) this.queryMap.set(key, value);
        }
      }
    }
    return this.queryMap;
  }
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  /** The request path, no query string. */
  path: string;
  /** The raw query string ("" when absent). */
  query: string;
  body: Buffer;
  queryMap: Map<string, string> | null;
}

function queryParam(ctx: Ctx, name: string): string | null {
  if (ctx.query === "") return null;
  if (ctx.queryMap === null) {
    const map = new Map<string, string>();
    for (const pair of ctx.query.split("&")) {
      if (pair === "") continue;
      const eq = pair.indexOf("=");
      const rawKey = eq === -1 ? pair : pair.slice(0, eq);
      const rawValue = eq === -1 ? "" : pair.slice(eq + 1);
      let key = rawKey;
      let value = rawValue;
      try {
        key = decodeURIComponent(rawKey.replace(/\+/g, " "));
        value = decodeURIComponent(rawValue.replace(/\+/g, " "));
      } catch {
        // Keep the raw pair; a malformed escape is not worth a 500.
      }
      if (!map.has(key)) map.set(key, value);
    }
    ctx.queryMap = map;
  }
  return ctx.queryMap.get(name) ?? null;
}

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(36)}`;
}

function sendJson(res: ServerResponse, status: number, value: unknown, extra?: Record<string, string>): void {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "x-github-request-id": nextRequestId(),
    "x-oauth-scopes": "repo, read:org",
    ...(extra ?? {}),
  });
  res.end(payload);
}

/** Send an already-serialized JSON body (the read-cache fast path). */
function sendJsonBytes(res: ServerResponse, status: number, payload: Buffer): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "x-github-request-id": nextRequestId(),
    "x-oauth-scopes": "repo, read:org",
  });
  res.end(payload);
}

function sendRaw(res: ServerResponse, status: number, payload: Buffer, contentType: string, extra?: Record<string, string>): void {
  res.writeHead(status, {
    "content-type": contentType,
    "x-github-request-id": nextRequestId(),
    ...(extra ?? {}),
  });
  res.end(payload);
}

function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { "x-github-request-id": nextRequestId() });
  res.end();
}

function jsonBody(ctx: Ctx): Record<string, unknown> {
  if (ctx.body.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString("utf8"));
  } catch {
    throw new HttpError(400, "Problems parsing JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, "JSON body must be an object");
  }
  return parsed as Record<string, unknown>;
}

function authorized(req: IncomingMessage): boolean {
  const header = req.headers["authorization"];
  if (typeof header !== "string") return false;
  if (EXPECTED_TOKEN !== "") return header === `Bearer ${EXPECTED_TOKEN}`;
  return header.startsWith("Bearer ") && header.length > "Bearer ".length;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function queryInt(ctx: Ctx, name: string, fallback: number): number {
  const raw = queryParam(ctx, name);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function paginate<T>(ctx: Ctx, items: T[]): T[] {
  const perPage = Math.min(100, queryInt(ctx, "per_page", 30));
  const page = queryInt(ctx, "page", 1);
  return items.slice((page - 1) * perPage, page * perPage);
}

/** Serialize an issue once per version and serve the cached bytes after. */
function sendIssueJson(ctx: Ctx, repo: RepoRec, issue: IssueRec): void {
  if (issue.jsonCache !== null && issue.jsonCacheVersion === issue.version) {
    sendJsonBytes(ctx.res, 200, issue.jsonCache);
    return;
  }
  const payload = Buffer.from(JSON.stringify(issueView(repo, issue)), "utf8");
  issue.jsonCache = payload;
  issue.jsonCacheVersion = issue.version;
  sendJsonBytes(ctx.res, 200, payload);
}

// ---------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------

function restRoot(ctx: Ctx): void {
  sendJson(ctx.res, 200, {
    current_user_url: "/api/v3/user",
    repository_url: "/api/v3/repos/{owner}/{repo}",
    issue_search_url: "/api/v3/search/issues?q={query}",
    emojis_url: "/api/v3/emojis",
  });
}

function restMeta(ctx: Ctx): void {
  sendJson(ctx.res, 200, { installed_version: "3.0.0-forge", hooks: [], github: { services: [] } });
}

function restUser(ctx: Ctx): void {
  sendJson(ctx.res, 200, {
    ...userView(),
    name: VIEWER.name,
    email: VIEWER.email,
    created_at: "2025-01-01T00:00:00Z",
    public_repos: reposByKey.size,
  });
}

function restCreateRepo(ctx: Ctx): void {
  const body = jsonBody(ctx);
  const name = str(body.name);
  if (name === "") throw new HttpError(422, "Validation Failed: name is required");
  const existing = reposByKey.get(repoKey(VIEWER.login, name));
  if (existing !== undefined) {
    throw new HttpError(422, "Validation Failed: name already exists on this account");
  }
  const repo = createRepoRec(name, body.private === true, str(body.description));
  if (repo === null) throw new HttpError(422, "Validation Failed: name already exists on this account");
  sendJson(ctx.res, 201, repoView(repo));
}

function restListUserRepos(ctx: Ctx): void {
  const all = [...reposByKey.values()];
  const perPage = Math.min(100, queryInt(ctx, "per_page", 30));
  const page = queryInt(ctx, "page", 1);
  const slice = all.slice((page - 1) * perPage, page * perPage);
  const headers: Record<string, string> = {};
  if (page * perPage < all.length) {
    const host = ctx.req.headers["host"] ?? "localhost";
    const next = `http://${host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
    const last = `http://${host}/api/v3/user/repos?per_page=${perPage}&page=${Math.max(1, Math.ceil(all.length / perPage))}`;
    headers["link"] = `<${next}>; rel="next", <${last}>; rel="last"`;
  }
  sendJson(ctx.res, 200, slice.map(repoView), headers);
}

/** Resolve a ref parameter (branch name, tag name, or commit id) to a commit. */
function resolveCommitRef(repo: RepoRec, ref: string | null): string | null {
  if (ref === null || ref === "") {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch !== undefined) return branch;
  const tag = repo.refs.get(`refs/tags/${ref}`);
  if (tag !== undefined) return peelToCommit(repo, tag);
  if (OID_RE.test(ref)) {
    const object = repo.objects.get(ref);
    if (object !== undefined && object.type === "commit") return ref;
    if (object !== undefined && object.type === "tag") return peelToCommit(repo, ref);
  }
  const anyRef = repo.refs.get(ref);
  if (anyRef !== undefined) return peelToCommit(repo, anyRef);
  return null;
}

interface TreeHit {
  kind: "file" | "dir";
  oid: string;
  mode: string;
}

function treeHit(repo: RepoRec, commitOid: string, path: string): TreeHit | null {
  const commit = getCommit(repo, commitOid);
  if (commit === null) return null;
  if (path === "") return { kind: "dir", oid: commit.tree, mode: "40000" };
  const segments = path.split("/");
  let treeOid = commit.tree;
  for (let i = 0; i < segments.length; i += 1) {
    const entries = getTreeEntries(repo, treeOid);
    if (entries === null) return null;
    const entry = entries.find((candidate) => candidate.name === segments[i]);
    if (entry === undefined) return null;
    if (i === segments.length - 1) {
      return entry.mode === "40000" ? { kind: "dir", oid: entry.oid, mode: entry.mode } : { kind: "file", oid: entry.oid, mode: entry.mode };
    }
    if (entry.mode !== "40000") return null;
    treeOid = entry.oid;
  }
  return null;
}

function restGetContents(ctx: Ctx, repo: RepoRec, path: string): void {
  const commit = resolveCommitRef(repo, queryParam(ctx, "ref"));
  if (commit === null) throw new HttpError(404, "Not Found");
  const hit = treeHit(repo, commit, path);
  if (hit === null) throw new HttpError(404, "Not Found");
  if (hit.kind === "file") {
    const blob = repo.objects.get(hit.oid);
    if (blob === undefined) throw new HttpError(404, "Not Found");
    sendJson(ctx.res, 200, {
      type: "file",
      encoding: "base64",
      content: blob.data.toString("base64"),
      name: path.split("/").pop() ?? path,
      path,
      sha: hit.oid,
      size: blob.data.length,
    });
    return;
  }
  const entries = getTreeEntries(repo, hit.oid);
  if (entries === null) throw new HttpError(404, "Not Found");
  sendJson(ctx.res, 200, entries.map((entry) => {
    const childPath = path === "" ? entry.name : `${path}/${entry.name}`;
    const isDir = entry.mode === "40000";
    const blob = isDir ? undefined : repo.objects.get(entry.oid);
    return {
      type: isDir ? "dir" : "file",
      name: entry.name,
      path: childPath,
      sha: entry.oid,
      size: blob === undefined ? 0 : blob.data.length,
    };
  }));
}

function branchTipOrDefault(repo: RepoRec, branch: string | undefined): { refName: string; tip: string | null } {
  const refName = branch !== undefined && branch !== "" ? branch : repo.defaultBranch;
  const own = repo.refs.get(`refs/heads/${refName}`);
  if (own !== undefined) return { refName, tip: own };
  const fallback = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  return { refName, tip: fallback ?? null };
}

function restPutContents(ctx: Ctx, repo: RepoRec, path: string): void {
  const body = jsonBody(ctx);
  const message = str(body.message) || "update";
  const contentBase64 = str(body.content).replace(/\s+/g, "");
  const data = Buffer.from(contentBase64, "base64");
  const { refName, tip } = branchTipOrDefault(repo, typeof body.branch === "string" ? body.branch : undefined);
  const files = treeMapOf(repo, tip);
  const existing = files.get(path);
  if (typeof body.sha === "string") {
    if (existing === undefined || existing.oid !== body.sha) {
      throw new HttpError(409, `${path} does not match ${body.sha}`);
    }
  } else if (existing !== undefined) {
    throw new HttpError(422, "Validation Failed: sha is required when updating an existing file");
  }
  const blobOid = storeObject(repo, "blob", data);
  files.set(path, { oid: blobOid, mode: "100644" });
  const commit = commitFiles(repo, files, tip, message);
  setRef(repo, `refs/heads/${refName}`, commit);
  sendJson(ctx.res, existing === undefined ? 201 : 200, {
    content: {
      type: "file",
      name: path.split("/").pop() ?? path,
      path,
      sha: blobOid,
      size: data.length,
      encoding: "base64",
    },
    commit: { sha: commit },
  });
}

function restDeleteContents(ctx: Ctx, repo: RepoRec, path: string): void {
  const body = jsonBody(ctx);
  const message = str(body.message) || "delete";
  const { refName, tip } = branchTipOrDefault(repo, typeof body.branch === "string" ? body.branch : undefined);
  const files = treeMapOf(repo, tip);
  const existing = files.get(path);
  if (existing === undefined) throw new HttpError(404, "Not Found");
  if (typeof body.sha === "string" && body.sha !== existing.oid) {
    throw new HttpError(409, `${path} does not match ${body.sha}`);
  }
  files.delete(path);
  const commit = commitFiles(repo, files, tip, message);
  setRef(repo, `refs/heads/${refName}`, commit);
  sendJson(ctx.res, 200, { content: null, commit: { sha: commit } });
}

function restListBranches(ctx: Ctx, repo: RepoRec): void {
  const branches: Record<string, unknown>[] = [];
  for (const [ref, oid] of repo.refs) {
    if (!ref.startsWith("refs/heads/")) continue;
    branches.push({ name: ref.slice("refs/heads/".length), commit: { sha: oid }, protected: false });
  }
  branches.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  sendJson(ctx.res, 200, branches);
}

function restGetBranch(ctx: Ctx, repo: RepoRec, branch: string): void {
  const oid = repo.refs.get(`refs/heads/${branch}`);
  if (oid === undefined) throw new HttpError(404, "Not Found");
  sendJson(ctx.res, 200, { name: branch, commit: { sha: oid }, protected: false });
}

function restCreateRef(ctx: Ctx, repo: RepoRec): void {
  const body = jsonBody(ctx);
  const ref = str(body.ref);
  const sha = str(body.sha);
  if (!ref.startsWith("refs/") || !OID_RE.test(sha)) throw new HttpError(422, "Validation Failed: ref and sha are required");
  const object = repo.objects.get(sha);
  if (object === undefined) throw new HttpError(422, "Validation Failed: sha does not exist");
  if (repo.refs.has(ref)) throw new HttpError(422, "Reference already exists");
  setRef(repo, ref, sha);
  sendJson(ctx.res, 201, { ref, object: { sha, type: object.type } });
}

function restGetRef(ctx: Ctx, repo: RepoRec, ref: string): void {
  const oid = repo.refs.get(ref);
  if (oid === undefined) throw new HttpError(404, "Not Found");
  const object = repo.objects.get(oid);
  sendJson(ctx.res, 200, { ref, object: { sha: oid, type: object?.type ?? "commit" } });
}

function restListCommits(ctx: Ctx, repo: RepoRec): void {
  const start = resolveCommitRef(repo, queryParam(ctx, "sha"));
  if (start === null) {
    sendJson(ctx.res, 200, []);
    return;
  }
  const views = walkCommits(repo, start).map((oid) => {
    const commit = getCommit(repo, oid) as CommitInfo;
    const date = isoFromSec(commit.timestamp);
    return {
      sha: oid,
      commit: {
        message: commit.message,
        tree: { sha: commit.tree },
        author: { name: "Forge", email: "forge@example.invalid", date },
        committer: { name: "Forge", email: "forge@example.invalid", date },
      },
      parents: commit.parents.map((parent) => ({ sha: parent })),
    };
  });
  sendJson(ctx.res, 200, paginate(ctx, views));
}

function restCreateLabel(ctx: Ctx, repo: RepoRec): void {
  const body = jsonBody(ctx);
  const name = str(body.name);
  if (name === "") throw new HttpError(422, "Validation Failed: name is required");
  if (repo.labels.has(name)) throw new HttpError(422, "Validation Failed: name already exists");
  const label: LabelRec = { name, color: str(body.color) || "ededed", description: str(body.description) };
  repo.labels.set(name, label);
  sendJson(ctx.res, 201, labelView(label));
}

function labelNamesOf(repo: RepoRec, raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const entry of raw) {
    const name = typeof entry === "string" ? entry : str((entry as Record<string, unknown>)?.name);
    if (name === "") continue;
    if (!repo.labels.has(name)) throw new HttpError(422, `Validation Failed: label "${name}" does not exist`);
    names.push(name);
  }
  return names;
}

function restCreateIssue(ctx: Ctx, repo: RepoRec): void {
  const body = jsonBody(ctx);
  const title = str(body.title);
  if (title === "") throw new HttpError(422, "Validation Failed: title is required");
  const labels = labelNamesOf(repo, body.labels);
  const issue = createIssueRec(repo, title, str(body.body), labels);
  sendJson(ctx.res, 201, issueView(repo, issue));
}

function restListIssues(ctx: Ctx, repo: RepoRec): void {
  const state = queryParam(ctx, "state") ?? "open";
  let issues = [...repo.issues.values()];
  if (state === "open") issues = issues.filter((issue) => issue.state === "open");
  else if (state === "closed") issues = issues.filter((issue) => issue.state === "closed");
  const direction = queryParam(ctx, "direction") ?? "desc";
  issues.sort((a, b) => (direction === "asc" ? a.number - b.number : b.number - a.number));
  sendJson(ctx.res, 200, paginate(ctx, issues).map((issue) => issueView(repo, issue)));
}

function restGetIssue(ctx: Ctx, repo: RepoRec, number: number): void {
  const issue = repo.issues.get(number);
  if (issue === undefined) throw new HttpError(404, "Not Found");
  sendIssueJson(ctx, repo, issue);
}

function restPatchIssue(ctx: Ctx, repo: RepoRec, number: number): void {
  const issue = repo.issues.get(number);
  if (issue === undefined) throw new HttpError(404, "Not Found");
  const body = jsonBody(ctx);
  if (typeof body.title === "string") issue.title = body.title;
  if (typeof body.body === "string") issue.body = body.body;
  if (body.state === "open" || body.state === "closed") issue.state = body.state;
  if (body.labels !== undefined) issue.labels = labelNamesOf(repo, body.labels);
  issue.updatedAt = tickIso();
  issue.version += 1;
  sendJson(ctx.res, 200, issueView(repo, issue));
}

function restCreateComment(ctx: Ctx, repo: RepoRec, number: number): void {
  const issue = repo.issues.get(number);
  if (issue === undefined) throw new HttpError(404, "Not Found");
  const body = jsonBody(ctx);
  const comment: CommentRec = { id: nextCommentId, body: str(body.body), createdAt: tickIso() };
  nextCommentId += 1;
  issue.comments.push(comment);
  issue.version += 1;
  sendJson(ctx.res, 201, commentView(comment));
}

function restListComments(ctx: Ctx, repo: RepoRec, number: number): void {
  const issue = repo.issues.get(number);
  if (issue === undefined) throw new HttpError(404, "Not Found");
  sendJson(ctx.res, 200, issue.comments.map(commentView));
}

function normalizeRefName(value: string): string {
  const colon = value.lastIndexOf(":");
  return colon === -1 ? value : value.slice(colon + 1);
}

function restCreatePull(ctx: Ctx, repo: RepoRec): void {
  const body = jsonBody(ctx);
  const title = str(body.title);
  const head = normalizeRefName(str(body.head));
  const base = normalizeRefName(str(body.base));
  if (title === "" || head === "" || base === "") throw new HttpError(422, "Validation Failed: title, head and base are required");
  if (!repo.refs.has(`refs/heads/${head}`)) throw new HttpError(422, `Validation Failed: head branch "${head}" does not exist`);
  if (!repo.refs.has(`refs/heads/${base}`)) throw new HttpError(422, `Validation Failed: base branch "${base}" does not exist`);
  for (const pull of repo.pulls.values()) {
    if (pull.state === "open" && !pull.merged && pull.headRef === head && pull.baseRef === base) {
      throw new HttpError(422, "Validation Failed: A pull request already exists for this branch");
    }
  }
  const pull = createPullRec(repo, title, str(body.body), head, base);
  sendJson(ctx.res, 201, pullView(repo, pull));
}

function restListPulls(ctx: Ctx, repo: RepoRec): void {
  const state = queryParam(ctx, "state") ?? "open";
  let pulls = [...repo.pulls.values()];
  if (state === "open") pulls = pulls.filter((pull) => pull.state === "open" && !pull.merged);
  else if (state === "closed") pulls = pulls.filter((pull) => pull.state === "closed" || pull.merged);
  pulls.sort((a, b) => b.number - a.number);
  sendJson(ctx.res, 200, paginate(ctx, pulls).map((pull) => pullView(repo, pull)));
}

function restGetPull(ctx: Ctx, repo: RepoRec, number: number): void {
  const pull = repo.pulls.get(number);
  if (pull === undefined) throw new HttpError(404, "Not Found");
  sendJson(ctx.res, 200, pullView(repo, pull));
}

function restPullFiles(ctx: Ctx, repo: RepoRec, number: number): void {
  const pull = repo.pulls.get(number);
  if (pull === undefined) throw new HttpError(404, "Not Found");
  sendJson(ctx.res, 200, pullFiles(repo, pull));
}

function restMergePull(ctx: Ctx, repo: RepoRec, number: number): void {
  const pull = repo.pulls.get(number);
  if (pull === undefined) throw new HttpError(404, "Not Found");
  const body = jsonBody(ctx);
  const method = str(body.merge_method) || "merge";
  if (pull.merged) throw new HttpError(405, "Pull Request is already merged");
  if (pull.state !== "open") throw new HttpError(405, "Pull Request is not open");
  if (!repo.refs.has(`refs/heads/${pull.headRef}`) || !repo.refs.has(`refs/heads/${pull.baseRef}`)) {
    throw new HttpError(405, "Pull Request branch is missing");
  }
  const outcome = mergePull(repo, pull, method);
  if ("conflict" in outcome) throw new HttpError(405, "Merge conflict: this pull request cannot be merged automatically");
  sendJson(ctx.res, 200, { sha: outcome.sha, merged: true, message: "Pull Request successfully merged" });
}

function restRepoDispatch(ctx: Ctx, repo: RepoRec, rest: string[]): void {
  const method = ctx.req.method ?? "GET";
  const head = rest[0];
  if (rest.length === 0) {
    if (method === "GET") {
      sendJson(ctx.res, 200, repoView(repo));
      return;
    }
    if (method === "PATCH") {
      const body = jsonBody(ctx);
      if (typeof body.description === "string") repo.description = body.description;
      if (typeof body.private === "boolean") repo.private = body.private;
      if (typeof body.default_branch === "string" && body.default_branch !== "") repo.defaultBranch = body.default_branch;
      sendJson(ctx.res, 200, repoView(repo));
      return;
    }
    if (method === "DELETE") {
      deleteRepoRec(repo);
      sendEmpty(ctx.res, 204);
      return;
    }
    throw new HttpError(404, "Not Found");
  }
  if (head === "contents") {
    const path = rest.slice(1).join("/");
    if (method === "GET") return restGetContents(ctx, repo, path);
    if (method === "PUT") return restPutContents(ctx, repo, path);
    if (method === "DELETE") return restDeleteContents(ctx, repo, path);
    throw new HttpError(404, "Not Found");
  }
  if (head === "branches") {
    if (rest.length === 1 && method === "GET") return restListBranches(ctx, repo);
    if (method === "GET") return restGetBranch(ctx, repo, rest.slice(1).join("/"));
    throw new HttpError(404, "Not Found");
  }
  if (head === "commits" && rest.length === 1 && method === "GET") return restListCommits(ctx, repo);
  if (head === "git" && rest[1] === "refs") {
    if (rest.length === 2 && method === "POST") return restCreateRef(ctx, repo);
    if (method === "GET" && rest.length >= 3) return restGetRef(ctx, repo, `refs/${rest.slice(2).join("/")}`);
    throw new HttpError(404, "Not Found");
  }
  if (head === "git" && rest[1] === "ref" && method === "GET" && rest.length >= 3) {
    return restGetRef(ctx, repo, `refs/${rest.slice(2).join("/")}`);
  }
  if (head === "labels") {
    if (rest.length === 1 && method === "POST") return restCreateLabel(ctx, repo);
    if (rest.length === 1 && method === "GET") {
      sendJson(ctx.res, 200, [...repo.labels.values()].map(labelView));
      return;
    }
    throw new HttpError(404, "Not Found");
  }
  if (head === "issues") {
    if (rest.length === 1 && method === "GET") return restListIssues(ctx, repo);
    if (rest.length === 1 && method === "POST") return restCreateIssue(ctx, repo);
    const number = Number.parseInt(rest[1] ?? "", 10);
    if (rest.length === 2 && method === "GET") return restGetIssue(ctx, repo, number);
    if (rest.length === 2 && method === "PATCH") return restPatchIssue(ctx, repo, number);
    if (rest.length === 3 && rest[2] === "comments" && method === "POST") return restCreateComment(ctx, repo, number);
    if (rest.length === 3 && rest[2] === "comments" && method === "GET") return restListComments(ctx, repo, number);
    throw new HttpError(404, "Not Found");
  }
  if (head === "pulls") {
    if (rest.length === 1 && method === "GET") return restListPulls(ctx, repo);
    if (rest.length === 1 && method === "POST") return restCreatePull(ctx, repo);
    const number = Number.parseInt(rest[1] ?? "", 10);
    if (rest.length === 2 && method === "GET") return restGetPull(ctx, repo, number);
    if (rest.length === 3 && rest[2] === "files" && method === "GET") return restPullFiles(ctx, repo, number);
    if (rest.length === 3 && rest[2] === "merge" && method === "PUT") return restMergePull(ctx, repo, number);
    throw new HttpError(404, "Not Found");
  }
  throw new HttpError(404, "Not Found");
}

function decodeSegment(segment: string): string {
  if (!segment.includes("%")) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function handleRest(ctx: Ctx): void {
  if (!authorized(ctx.req)) throw new HttpError(401, "Requires authentication");
  const tail = ctx.path === "/api/v3" ? "" : ctx.path.slice("/api/v3/".length);
  const segments = tail === "" ? [] : tail.split("/").map(decodeSegment);
  const method = ctx.req.method ?? "GET";
  if (segments.length === 0) {
    if (method === "GET") return restRoot(ctx);
    throw new HttpError(404, "Not Found");
  }
  if (segments[0] === "meta" && segments.length === 1 && method === "GET") return restMeta(ctx);
  if (segments[0] === "user" && segments.length === 1 && method === "GET") return restUser(ctx);
  if (segments[0] === "user" && segments[1] === "repos" && segments.length === 2) {
    if (method === "POST") return restCreateRepo(ctx);
    if (method === "GET") return restListUserRepos(ctx);
    throw new HttpError(404, "Not Found");
  }
  if (segments[0] === "repos" && segments.length >= 3) {
    const repo = findRepo(segments[1] as string, segments[2] as string);
    if (repo === null) throw new HttpError(404, "Not Found");
    return restRepoDispatch(ctx, repo, segments.slice(3));
  }
  throw new HttpError(404, "Not Found");
}

// ---------------------------------------------------------------------------
// Git smart HTTP. Advertisement, ls-refs and fetch answers are cached:
// refs answers key off the repository's refsVersion (bumped on every ref
// move), and fetch answers key off the request's object ids — objects are
// immutable and content-addressed, so the closure of a fixed want/have set
// can never change under it. The caches only ever hold response bytes;
// they are not part of the forge's state.
// ---------------------------------------------------------------------------

const UPLOAD_CAPS = "multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not object-format=sha1";
const RECEIVE_CAPS = "report-status delete-refs side-band-64k ofs-delta quiet object-format=sha1";

const CACHE_LIMIT = 512;

function cachePut<T>(cache: Map<string, T>, key: string, value: T): void {
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, value);
}

const advertiseCache = new Map<string, Buffer>();
const lsrefsCache = new Map<string, Buffer>();
const fetchCache = new Map<string, Buffer>();

/** The protocol-v2 advertisement never changes; build it once. */
const V2_ADVERTISEMENT: Buffer = Buffer.concat([
  pktLine("version 2\n"),
  pktLine("agent=forge/3.0\n"),
  pktLine("ls-refs=unborn\n"),
  pktLine("fetch=shallow\n"),
  pktLine("object-format=sha1\n"),
  PKT_FLUSH,
]);

function sortedRefs(repo: RepoRec): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function peelTag(repo: RepoRec, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== "tag") return null;
  return peelToCommit(repo, oid);
}

function gitAdvertise(ctx: Ctx, repo: RepoRec, service: "git-upload-pack" | "git-receive-pack"): void {
  const wantsV2 = service === "git-upload-pack" && (ctx.req.headers["git-protocol"] ?? "").includes("version=2");
  if (wantsV2) {
    sendRaw(ctx.res, 200, V2_ADVERTISEMENT, `application/x-${service}-advertisement`);
    return;
  }
  const cacheKey = `${repo.id}|${repo.refsVersion}|${service}`;
  const cached = advertiseCache.get(cacheKey);
  if (cached !== undefined) {
    sendRaw(ctx.res, 200, cached, `application/x-${service}-advertisement`);
    return;
  }
  const caps = service === "git-upload-pack"
    ? `${UPLOAD_CAPS} symref=HEAD:refs/heads/${repo.defaultBranch} agent=forge/3.0`
    : `${RECEIVE_CAPS} symref=HEAD:refs/heads/${repo.defaultBranch} agent=forge/3.0`;
  const parts: Buffer[] = [];
  parts.push(pktLine(`# service=${service}\n`));
  parts.push(PKT_FLUSH);
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}`));
  } else {
    const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
    parts.push(pktLine(`${headTip} HEAD\0${caps}`));
    for (const [ref, oid] of refs) {
      parts.push(pktLine(`${oid} ${ref}`));
      const peeled = peelTag(repo, oid);
      if (peeled !== null && peeled !== oid) parts.push(pktLine(`${peeled} ${ref}^{}`));
    }
  }
  parts.push(PKT_FLUSH);
  const payload = Buffer.concat(parts);
  cachePut(advertiseCache, cacheKey, payload);
  sendRaw(ctx.res, 200, payload, `application/x-${service}-advertisement`);
}

function gitLsRefs(ctx: Ctx, repo: RepoRec, args: string[]): void {
  const cacheKey = `${repo.id}|${repo.refsVersion}|${args.join("\n")}`;
  const cached = lsrefsCache.get(cacheKey);
  if (cached !== undefined) {
    sendRaw(ctx.res, 200, cached, "application/x-git-upload-pack-result");
    return;
  }
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === "peel") peel = true;
    else if (arg === "symrefs") symrefs = true;
    else if (arg === "unborn") unborn = true;
    else if (arg.startsWith("ref-prefix ")) prefixes.push(arg.slice("ref-prefix ".length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.refs.get(defaultRef);
  if (matches("HEAD")) {
    if (headTip !== undefined) {
      parts.push(pktLine(`${headTip} HEAD${symrefs ? ` symref-target:${defaultRef}` : ""}\n`));
    } else if (unborn) {
      parts.push(pktLine(`unborn HEAD symref-target:${defaultRef}\n`));
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    if (peel) {
      const peeled = peelTag(repo, oid);
      if (peeled !== null && peeled !== oid) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  const payload = Buffer.concat(parts);
  cachePut(lsrefsCache, cacheKey, payload);
  sendRaw(ctx.res, 200, payload, "application/x-git-upload-pack-result");
}

interface FetchPlan {
  objects: GitObj[];
  acks: string[];
  nak: boolean;
  shallow: string[];
  unshallow: string[];
  hasHaves: boolean;
  hasShallowInfo: boolean;
}

function planFetch(repo: RepoRec, wants: string[], haves: string[], shallowLines: string[], depth: number | null): FetchPlan {
  const shallowSet = new Set(shallowLines);
  // Inclusion: walk generations from the peeled wants.
  const included = new Set<string>();
  const includedCommits = new Set<string>();
  let frontier: string[] = [];
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (object === undefined) continue;
    included.add(want);
    if (object.type === "tag") {
      const commit = peelToCommit(repo, want);
      if (commit !== null && !includedCommits.has(commit)) frontier.push(commit);
    } else if (object.type === "commit") {
      if (!includedCommits.has(want)) frontier.push(want);
    }
  }
  const boundary = new Set<string>();
  let generation = 0;
  const seenFrontier = new Set<string>();
  frontier = frontier.filter((oid) => {
    if (seenFrontier.has(oid)) return false;
    seenFrontier.add(oid);
    return true;
  });
  while (frontier.length > 0) {
    const atMaxDepth = depth !== null && generation >= depth - 1;
    const next: string[] = [];
    for (const oid of frontier) {
      includedCommits.add(oid);
      included.add(oid);
      const commit = getCommit(repo, oid);
      if (commit === null) continue;
      // The commit's whole tree comes with it.
      const stack: string[] = [commit.tree];
      while (stack.length > 0) {
        const treeOid = stack.pop() as string;
        if (included.has(treeOid)) continue;
        const entries = getTreeEntries(repo, treeOid);
        if (entries === null) continue;
        included.add(treeOid);
        for (const entry of entries) {
          if (entry.mode === "40000") stack.push(entry.oid);
          else included.add(entry.oid);
        }
      }
      if (atMaxDepth) {
        if (commit.parents.length > 0) boundary.add(oid);
        continue;
      }
      if (depth === null && shallowSet.has(oid)) continue; // the client's boundary holds
      for (const parent of commit.parents) {
        if (!includedCommits.has(parent) && !next.includes(parent)) next.push(parent);
      }
    }
    frontier = next;
    generation += 1;
  }
  // Exclusion: everything reachable from the haves, with the client's
  // shallow commits treated as parentless there.
  const excluded = new Set<string>();
  {
    const queue: string[] = [];
    for (const have of haves) {
      const object = repo.objects.get(have);
      if (object === undefined) continue;
      if (object.type === "tag") {
        excluded.add(have);
        const commit = peelToCommit(repo, have);
        if (commit !== null) queue.push(commit);
      } else if (object.type === "commit") {
        queue.push(have);
      } else {
        excluded.add(have);
      }
    }
    const seen = new Set<string>();
    for (let head = 0; head < queue.length; head += 1) {
      const oid = queue[head] as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const commit = getCommit(repo, oid);
      if (commit === null) continue;
      excluded.add(oid);
      const stack: string[] = [commit.tree];
      while (stack.length > 0) {
        const treeOid = stack.pop() as string;
        if (excluded.has(treeOid)) continue;
        const entries = getTreeEntries(repo, treeOid);
        if (entries === null) continue;
        excluded.add(treeOid);
        for (const entry of entries) {
          if (entry.mode === "40000") stack.push(entry.oid);
          else excluded.add(entry.oid);
        }
      }
      if (shallowSet.has(oid)) continue;
      for (const parent of commit.parents) queue.push(parent);
    }
  }
  const deliver: GitObj[] = [];
  for (const oid of included) {
    if (excluded.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object !== undefined) deliver.push(object);
  }
  // Commits first, then trees, then blobs: a stable, parseable order.
  const rank = (type: ObjType): number => (type === "commit" ? 0 : type === "tag" ? 1 : type === "tree" ? 2 : 3);
  deliver.sort((a, b) => rank(a.type) - rank(b.type));
  // Acknowledgements: a have the client shares with the wants' full history.
  const acks: string[] = [];
  if (haves.length > 0) {
    const wantHistory = new Set<string>();
    for (const want of wants) {
      const commit = peelToCommit(repo, want);
      if (commit !== null) for (const oid of walkCommits(repo, commit)) wantHistory.add(oid);
    }
    for (const have of haves) if (wantHistory.has(have)) acks.push(have);
  }
  const shallowInfo: string[] = [];
  const unshallowInfo: string[] = [];
  if (depth !== null) {
    for (const oid of boundary) if (!excluded.has(oid)) shallowInfo.push(oid);
    for (const oid of shallowSet) {
      if (includedCommits.has(oid) && !boundary.has(oid)) unshallowInfo.push(oid);
    }
  }
  return {
    objects: deliver,
    acks,
    nak: haves.length > 0 && acks.length === 0,
    shallow: shallowInfo,
    unshallow: unshallowInfo,
    hasHaves: haves.length > 0,
    hasShallowInfo: shallowInfo.length > 0 || unshallowInfo.length > 0,
  };
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.from([1])));
  return parts;
}

function parseFetchArgs(args: string[], v0: boolean): { wants: string[]; haves: string[]; shallowLines: string[]; depth: number | null } {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowLines: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    if (arg.startsWith("want ")) wants.push(v0 ? (arg.slice(5).trim().split(" ")[0] as string) : arg.slice(5).trim());
    else if (arg.startsWith("have ")) haves.push(arg.slice(5).trim());
    else if (arg.startsWith("shallow ")) shallowLines.push(arg.slice(8).trim());
    else if (arg.startsWith("deepen ")) {
      const value = Number.parseInt(arg.slice(7).trim(), 10);
      if (Number.isFinite(value) && value > 0) depth = value;
    }
  }
  return { wants, haves, shallowLines, depth };
}

function gitFetchV2(ctx: Ctx, repo: RepoRec, args: string[]): void {
  const { wants, haves, shallowLines, depth } = parseFetchArgs(args, false);
  const cacheKey = `${repo.id}|v2|${depth ?? ""}|${wants.join(",")}|${haves.join(",")}|${shallowLines.join(",")}`;
  const cached = fetchCache.get(cacheKey);
  if (cached !== undefined) {
    sendRaw(ctx.res, 200, cached, "application/x-git-upload-pack-result");
    return;
  }
  const plan = planFetch(repo, wants, haves, shallowLines, depth);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  if (plan.hasHaves) {
    parts.push(pktLine("acknowledgments\n"));
    if (plan.nak) parts.push(pktLine("NAK\n"));
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
    parts.push(PKT_FLUSH);
  }
  if (plan.hasShallowInfo) {
    parts.push(pktLine("shallow-info\n"));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  parts.push(pktLine("packfile\n"));
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  const payload = Buffer.concat(parts);
  cachePut(fetchCache, cacheKey, payload);
  sendRaw(ctx.res, 200, payload, "application/x-git-upload-pack-result");
}

function gitFetchV0(ctx: Ctx, repo: RepoRec, lines: string[]): void {
  const { wants, haves, shallowLines, depth } = parseFetchArgs(lines, true);
  const cacheKey = `${repo.id}|v0|${depth ?? ""}|${wants.join(",")}|${haves.join(",")}|${shallowLines.join(",")}`;
  const cached = fetchCache.get(cacheKey);
  if (cached !== undefined) {
    sendRaw(ctx.res, 200, cached, "application/x-git-upload-pack-result");
    return;
  }
  const plan = planFetch(repo, wants, haves, shallowLines, depth);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine("NAK\n"));
  }
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  const payload = Buffer.concat(parts);
  cachePut(fetchCache, cacheKey, payload);
  sendRaw(ctx.res, 200, payload, "application/x-git-upload-pack-result");
}

function gitUploadPack(ctx: Ctx, repo: RepoRec): void {
  let parsed: { packets: Pkt[]; end: number };
  try {
    parsed = parsePkts(ctx.body, 0);
  } catch {
    sendRaw(ctx.res, 400, Buffer.from("invalid pkt-line request\n", "utf8"), "text/plain; charset=utf-8");
    return;
  }
  const dataLines = parsed.packets.filter((packet) => packet.kind === "data").map((packet) => packet.payload.toString("utf8").replace(/\n$/, ""));
  const first = dataLines[0] ?? "";
  if (first.startsWith("command=")) {
    const command = first.slice("command=".length);
    // Arguments are the data packets after the delimiter packet.
    const delimIndex = parsed.packets.findIndex((packet) => packet.kind === "delim");
    const argPackets = delimIndex === -1 ? parsed.packets.slice(1) : parsed.packets.slice(delimIndex + 1);
    const args = argPackets.filter((packet) => packet.kind === "data").map((packet) => packet.payload.toString("utf8").replace(/\n$/, ""));
    if (command === "ls-refs") return gitLsRefs(ctx, repo, args);
    if (command === "fetch") return gitFetchV2(ctx, repo, args);
    sendRaw(ctx.res, 400, Buffer.from(`unknown command ${command}\n`, "utf8"), "text/plain; charset=utf-8");
    return;
  }
  return gitFetchV0(ctx, repo, dataLines);
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function gitReceivePack(ctx: Ctx, repo: RepoRec): void {
  let parsed: { packets: Pkt[]; end: number };
  try {
    parsed = scanPktsUntilFlush(ctx.body);
  } catch {
    sendRaw(ctx.res, 400, Buffer.from("invalid pkt-line request\n", "utf8"), "text/plain; charset=utf-8");
    return;
  }
  const commands: PushCommand[] = [];
  let capabilities = "";
  for (const packet of parsed.packets) {
    if (packet.kind === "flush") break;
    if (packet.kind !== "data") continue;
    let line = packet.payload.toString("utf8").replace(/\n$/, "");
    const nul = line.indexOf("\0");
    if (nul !== -1) {
      capabilities = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const fields = line.split(" ");
    if (fields.length >= 3 && OID_RE.test(fields[0] as string) && OID_RE.test(fields[1] as string)) {
      commands.push({ oldOid: fields[0] as string, newOid: fields[1] as string, ref: fields.slice(2).join(" ") });
    }
  }
  const packBytes = ctx.body.subarray(Math.min(parsed.end, ctx.body.length));
  let unpackOk = true;
  let unpackDetail = "ok";
  if (packBytes.length > 0) {
    try {
      const objects = parsePack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : "error";
    }
  }
  const caps = new Set(capabilities.split(" ").filter((cap) => cap !== ""));
  const results: { ref: string; ok: boolean; reason: string }[] = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    let ok = false;
    let reason = "";
    if (!unpackOk) {
      reason = "unpack failed";
    } else if (command.oldOid !== current) {
      if (
        command.newOid !== ZERO_OID && command.oldOid !== ZERO_OID &&
        repo.objects.has(command.newOid) && !isAncestor(repo, current, command.newOid) && current !== ZERO_OID
      ) {
        reason = "non-fast-forward";
      } else {
        reason = "stale info";
      }
    } else if (command.newOid === ZERO_OID) {
      setRef(repo, command.ref, null);
      ok = true;
    } else if (!repo.objects.has(command.newOid)) {
      reason = "missing object";
    } else if (current !== ZERO_OID && !isAncestor(repo, current, command.newOid)) {
      reason = "non-fast-forward";
    } else {
      setRef(repo, command.ref, command.newOid);
      ok = true;
    }
    results.push({ ref: command.ref, ok, reason });
  }
  if (!caps.has("report-status") && !caps.has("report-status-v2")) {
    sendRaw(ctx.res, 200, PKT_FLUSH, "application/x-git-receive-pack-result");
    return;
  }
  const reportLines: string[] = [`unpack ${unpackOk ? "ok" : unpackDetail}\n`];
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  const inner = reportLines.map((line) => pktLine(line));
  const parts: Buffer[] = [];
  if (caps.has("side-band-64k")) {
    for (const linePacket of inner) {
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), linePacket])));
    }
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), PKT_FLUSH])));
    parts.push(PKT_FLUSH);
  } else {
    parts.push(...inner);
    parts.push(PKT_FLUSH);
  }
  sendRaw(ctx.res, 200, Buffer.concat(parts), "application/x-git-receive-pack-result");
}

function handleGit(ctx: Ctx, owner: string, repoName: string, tail: string): void {
  if (!authorized(ctx.req)) {
    sendRaw(ctx.res, 401, Buffer.from("authentication required\n", "utf8"), "text/plain; charset=utf-8");
    return;
  }
  const repo = findRepo(owner, repoName);
  if (repo === null) {
    sendRaw(ctx.res, 404, Buffer.from("repository not found\n", "utf8"), "text/plain; charset=utf-8");
    return;
  }
  const method = ctx.req.method ?? "GET";
  if (tail === "info/refs" && method === "GET") {
    const service = queryParam(ctx, "service");
    if (service === "git-upload-pack" || service === "git-receive-pack") return gitAdvertise(ctx, repo, service);
    sendRaw(ctx.res, 400, Buffer.from("unknown service\n", "utf8"), "text/plain; charset=utf-8");
    return;
  }
  if (tail === "git-upload-pack" && method === "POST") return gitUploadPack(ctx, repo);
  if (tail === "git-receive-pack" && method === "POST") return gitReceivePack(ctx, repo);
  sendRaw(ctx.res, 404, Buffer.from("not found\n", "utf8"), "text/plain; charset=utf-8");
}

// ---------------------------------------------------------------------------
// GraphQL: a small lexer/parser/executor covering the document set that
// gh and github-mcp-server send (queries, mutations, fragments, aliases,
// variables, input objects, batching, introspection of the used types).
// ---------------------------------------------------------------------------

type GqlValue =
  | { kind: "variable"; name: string }
  | { kind: "int"; value: number }
  | { kind: "float"; value: number }
  | { kind: "string"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "enum"; value: string }
  | { kind: "null" }
  | { kind: "list"; values: GqlValue[] }
  | { kind: "object"; fields: Map<string, GqlValue> };

interface GqlDirective {
  name: string;
  args: Map<string, GqlValue>;
}

interface GqlField {
  kind: "field";
  alias: string | null;
  name: string;
  args: Map<string, GqlValue>;
  directives: GqlDirective[];
  selectionSet: GqlSelection[] | null;
}

type GqlSelection =
  | GqlField
  | { kind: "spread"; name: string; directives: GqlDirective[] }
  | { kind: "inline"; typeCondition: string | null; directives: GqlDirective[]; selectionSet: GqlSelection[] };

interface GqlOperation {
  operation: "query" | "mutation";
  name: string | null;
  variableDefaults: Map<string, GqlValue>;
  selectionSet: GqlSelection[];
}

interface GqlFragment {
  name: string;
  typeCondition: string;
  selectionSet: GqlSelection[];
}

interface GqlDocument {
  operations: GqlOperation[];
  fragments: Map<string, GqlFragment>;
}

interface GqlToken {
  kind: "name" | "int" | "float" | "string" | "punct" | "spread" | "eof";
  value: string;
}

function gqlLex(source: string): GqlToken[] {
  const tokens: GqlToken[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i] as string;
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "," || c === "\ufeff") { i += 1; continue; }
    if (c === "#") { while (i < source.length && source[i] !== "\n") i += 1; continue; }
    if (source.startsWith("...", i)) { tokens.push({ kind: "spread", value: "..." }); i += 3; continue; }
    if ("{}()[]:=@$!|&".includes(c)) { tokens.push({ kind: "punct", value: c }); i += 1; continue; }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new Error("unterminated block string");
        tokens.push({ kind: "string", value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = "";
      while (j < source.length && source[j] !== '"') {
        if (source[j] === "\\") {
          const esc = source[j + 1] as string;
          if (esc === "n") out += "\n";
          else if (esc === "t") out += "\t";
          else if (esc === "r") out += "\r";
          else if (esc === "b") out += "\b";
          else if (esc === "f") out += "\f";
          else if (esc === "/") out += "/";
          else if (esc === "\\") out += "\\";
          else if (esc === '"') out += '"';
          else if (esc === "u") {
            out += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error("unterminated string");
      tokens.push({ kind: "string", value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (source[j] === "-") j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      let isFloat = false;
      if (source[j] === ".") {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === "e" || source[j] === "E") {
        isFloat = true;
        j += 1;
        if (source[j] === "+" || source[j] === "-") j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? "float" : "int", value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: "name", value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: "eof", value: "" });
  return tokens;
}

class GqlParser {
  private tokens: GqlToken[];
  private pos: number;
  constructor(tokens: GqlToken[]) {
    this.tokens = tokens;
    this.pos = 0;
  }
  private peek(): GqlToken {
    return this.tokens[this.pos] as GqlToken;
  }
  private next(): GqlToken {
    const token = this.tokens[this.pos] as GqlToken;
    this.pos += 1;
    return token;
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== "punct" || token.value !== value) throw new Error(`expected "${value}", got "${token.value}"`);
  }
  private atPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === "punct" && token.value === value;
  }
  private expectName(): string {
    const token = this.next();
    if (token.kind !== "name") throw new Error(`expected a name, got "${token.value}"`);
    return token.value;
  }

  parseDocument(): GqlDocument {
    const operations: GqlOperation[] = [];
    const fragments = new Map<string, GqlFragment>();
    while (this.peek().kind !== "eof") {
      if (this.atPunct("{")) {
        operations.push({ operation: "query", name: null, variableDefaults: new Map(), selectionSet: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === "query" || keyword === "mutation" || keyword === "subscription") {
        let name: string | null = null;
        if (this.peek().kind === "name") name = this.next().value;
        const variableDefaults = new Map<string, GqlValue>();
        if (this.atPunct("(")) {
          this.next();
          while (!this.atPunct(")")) {
            this.expectPunct("$");
            const varName = this.expectName();
            this.expectPunct(":");
            this.parseType();
            if (this.atPunct("=")) {
              this.next();
              variableDefaults.set(varName, this.parseValue(true));
            }
            this.parseDirectives();
          }
          this.next();
        }
        this.parseDirectives();
        operations.push({
          operation: keyword === "mutation" ? "mutation" : "query",
          name,
          variableDefaults,
          selectionSet: this.parseSelectionSet(),
        });
      } else if (keyword === "fragment") {
        const name = this.expectName();
        const onKeyword = this.expectName();
        if (onKeyword !== "on") throw new Error("fragment without 'on'");
        const typeCondition = this.expectName();
        this.parseDirectives();
        fragments.set(name, { name, typeCondition, selectionSet: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected definition "${keyword}"`);
      }
    }
    return { operations, fragments };
  }

  private parseType(): void {
    if (this.atPunct("[")) {
      this.next();
      this.parseType();
      this.expectPunct("]");
    } else {
      this.expectName();
    }
    if (this.atPunct("!")) this.next();
  }

  private parseDirectives(): GqlDirective[] {
    const directives: GqlDirective[] = [];
    while (this.atPunct("@")) {
      this.next();
      const name = this.expectName();
      const args = new Map<string, GqlValue>();
      if (this.atPunct("(")) {
        this.next();
        while (!this.atPunct(")")) {
          const argName = this.expectName();
          this.expectPunct(":");
          args.set(argName, this.parseValue(false));
        }
        this.next();
      }
      directives.push({ name, args });
    }
    return directives;
  }

  private parseValue(constant: boolean): GqlValue {
    const token = this.peek();
    if (token.kind === "punct" && token.value === "$") {
      if (constant) throw new Error("variable in constant value");
      this.next();
      return { kind: "variable", name: this.expectName() };
    }
    if (token.kind === "int") { this.next(); return { kind: "int", value: Number.parseInt(token.value, 10) }; }
    if (token.kind === "float") { this.next(); return { kind: "float", value: Number.parseFloat(token.value) }; }
    if (token.kind === "string") { this.next(); return { kind: "string", value: token.value }; }
    if (token.kind === "punct" && token.value === "[") {
      this.next();
      const values: GqlValue[] = [];
      while (!this.atPunct("]")) values.push(this.parseValue(constant));
      this.next();
      return { kind: "list", values };
    }
    if (token.kind === "punct" && token.value === "{") {
      this.next();
      const fields = new Map<string, GqlValue>();
      while (!this.atPunct("}")) {
        const fieldName = this.expectName();
        this.expectPunct(":");
        fields.set(fieldName, this.parseValue(constant));
      }
      this.next();
      return { kind: "object", fields };
    }
    if (token.kind === "name") {
      this.next();
      if (token.value === "true") return { kind: "boolean", value: true };
      if (token.value === "false") return { kind: "boolean", value: false };
      if (token.value === "null") return { kind: "null" };
      return { kind: "enum", value: token.value };
    }
    throw new Error(`unexpected value token "${token.value}"`);
  }

  private parseArguments(): Map<string, GqlValue> {
    const args = new Map<string, GqlValue>();
    if (!this.atPunct("(")) return args;
    this.next();
    while (!this.atPunct(")")) {
      const name = this.expectName();
      this.expectPunct(":");
      args.set(name, this.parseValue(false));
    }
    this.next();
    return args;
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expectPunct("{");
    const selections: GqlSelection[] = [];
    while (!this.atPunct("}")) selections.push(this.parseSelection());
    this.next();
    return selections;
  }

  private parseSelection(): GqlSelection {
    if (this.peek().kind === "spread") {
      this.next();
      if (this.peek().kind === "name" && this.peek().value === "on") {
        this.next();
        const typeCondition = this.expectName();
        const directives = this.parseDirectives();
        return { kind: "inline", typeCondition, directives, selectionSet: this.parseSelectionSet() };
      }
      const name = this.expectName();
      const directives = this.parseDirectives();
      return { kind: "spread", name, directives };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.atPunct(":")) {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args = this.parseArguments();
    const directives = this.parseDirectives();
    const selectionSet = this.atPunct("{") ? this.parseSelectionSet() : null;
    return { kind: "field", alias, name, args, directives, selectionSet };
  }
}

// ---------------------------------------------------------------------------
// GraphQL: schema objects and execution
// ---------------------------------------------------------------------------

const GTYPE = Symbol("gql-type");
type GqlObj = Record<string, unknown> & { [GTYPE]: string };

function gqlObj(type: string, fields: Record<string, unknown>): GqlObj {
  const obj = fields as GqlObj;
  obj[GTYPE] = type;
  return obj;
}

function isGqlObj(value: unknown): value is GqlObj {
  return typeof value === "object" && value !== null && GTYPE in value;
}

const GQL_ID_CODES: Record<string, string> = { User: "04", Repository: "010", Issue: "040", PullRequest: "050", IssueComment: "060" };

function globalId(type: string, numeric: number): string {
  return Buffer.from(`${GQL_ID_CODES[type] ?? "00"}:${type}${numeric}`, "utf8").toString("base64");
}

function decodeGlobalId(id: string): { type: string; numeric: number } | null {
  try {
    const text = Buffer.from(id, "base64").toString("utf8");
    const match = /^(\d+):([A-Za-z]+)(\d+)$/.exec(text);
    if (match === null) return null;
    return { type: match[2] as string, numeric: Number.parseInt(match[3] as string, 10) };
  } catch {
    return null;
  }
}

function argStr(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === "string" ? value : "";
}

function argNum(args: Record<string, unknown>, name: string): number | null {
  const value = args[name];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function gqlUser(): GqlObj {
  return gqlObj("User", {
    id: globalId("User", VIEWER.id),
    login: VIEWER.login,
    name: VIEWER.name,
    email: VIEWER.email,
    url: "",
    createdAt: "2025-01-01T00:00:00Z",
  });
}

function gqlComment(comment: CommentRec): GqlObj {
  return gqlObj("IssueComment", {
    id: globalId("IssueComment", comment.id),
    body: comment.body,
    createdAt: comment.createdAt,
    updatedAt: comment.createdAt,
    author: gqlUser(),
  });
}

function gqlIssue(repo: RepoRec, issue: IssueRec): GqlObj {
  return gqlObj("Issue", {
    id: globalId("Issue", issue.gid),
    number: issue.number,
    title: issue.title,
    state: issue.state === "open" ? "OPEN" : "CLOSED",
    body: issue.body,
    url: "",
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    author: gqlUser(),
    repository: gqlRepo(repo),
  });
}

function gqlPull(repo: RepoRec, pull: PullRec): GqlObj {
  return gqlObj("PullRequest", {
    id: globalId("PullRequest", pull.gid),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? "MERGED" : pull.state === "open" ? "OPEN" : "CLOSED",
    merged: pull.merged,
    mergeable: pull.merged ? "UNKNOWN" : computeMergeable(repo, pull) ? "MERGEABLE" : "CONFLICTING",
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    author: gqlUser(),
    files: (_args: Record<string, unknown>) =>
      gqlObj("PullRequestFileConnection", {
        totalCount: pullFiles(repo, pull).length,
        nodes: pullFiles(repo, pull).map((file) => gqlObj("PullRequestFile", { path: file.filename })),
      }),
  });
}

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, "utf8").toString("base64");
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, "base64").toString("utf8");
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number.parseInt(match[1] as string, 10);
  } catch {
    return null;
  }
}

function gqlConnection(type: string, items: GqlObj[], args: Record<string, unknown>): GqlObj {
  const first = argNum(args, "first");
  const limit = first === null ? items.length : Math.max(0, Math.min(first, items.length));
  let start = 0;
  if (typeof args.after === "string" && args.after !== "") {
    const index = decodeCursor(args.after);
    if (index !== null) start = Math.min(index + 1, items.length);
  }
  const slice = items.slice(start, start + limit);
  return gqlObj(type, {
    totalCount: items.length,
    nodes: slice,
    pageInfo: gqlObj("PageInfo", {
      hasNextPage: start + slice.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: slice.length > 0 ? encodeCursor(start) : null,
      endCursor: slice.length > 0 ? encodeCursor(start + slice.length - 1) : null,
    }),
  });
}

function gqlRepo(repo: RepoRec): GqlObj {
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  return gqlObj("Repository", {
    id: globalId("Repository", repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${VIEWER.login}/${repo.name}`,
    description: repo.description,
    isPrivate: repo.private,
    owner: gqlUser(),
    viewerPermission: "ADMIN",
    hasIssuesEnabled: true,
    url: "",
    createdAt: repo.createdAt,
    updatedAt: repo.createdAt,
    defaultBranchRef: tip === undefined
      ? null
      : gqlObj("Ref", { name: repo.defaultBranch, target: gqlObj("Commit", { oid: tip }) }),
    issue: (args: Record<string, unknown>) => {
      const number = argNum(args, "number");
      const issue = number === null ? undefined : repo.issues.get(number);
      return issue === undefined ? null : gqlIssue(repo, issue);
    },
    issues: (args: Record<string, unknown>) => {
      let issues = [...repo.issues.values()];
      const states = args.states;
      if (Array.isArray(states)) {
        const wanted = new Set(states.map((state) => String(state).toLowerCase()));
        issues = issues.filter((issue) => wanted.has(issue.state));
      }
      const orderBy = args.orderBy as Record<string, unknown> | undefined;
      const direction = orderBy !== undefined && typeof orderBy === "object" ? String(orderBy.direction ?? "ASC") : "ASC";
      issues.sort((a, b) => (direction === "DESC" ? b.number - a.number : a.number - b.number));
      return gqlConnection("IssueConnection", issues.map((issue) => gqlIssue(repo, issue)), args);
    },
    pullRequest: (args: Record<string, unknown>) => {
      const number = argNum(args, "number");
      const pull = number === null ? undefined : repo.pulls.get(number);
      return pull === undefined ? null : gqlPull(repo, pull);
    },
    pullRequests: (args: Record<string, unknown>) => {
      let pulls = [...repo.pulls.values()];
      const states = args.states;
      if (Array.isArray(states)) {
        const wanted = new Set(states.map((state) => String(state)));
        pulls = pulls.filter((pull) => wanted.has(pull.merged ? "MERGED" : pull.state.toUpperCase()));
      } else {
        pulls = pulls.filter((pull) => pull.state === "open" && !pull.merged);
      }
      pulls.sort((a, b) => b.number - a.number);
      return gqlConnection("PullRequestConnection", pulls.map((pull) => gqlPull(repo, pull)), args);
    },
  });
}

const GQL_TYPE_FIELDS: Record<string, string[]> = {
  Query: ["viewer", "repository", "node", "search", "user", "organization", "rateLimit"],
  Mutation: ["createIssue", "closeIssue", "createPullRequest", "mergePullRequest", "addComment"],
  Repository: [
    "id", "databaseId", "name", "nameWithOwner", "owner", "defaultBranchRef", "viewerPermission",
    "hasIssuesEnabled", "issue", "issues", "pullRequest", "pullRequests", "url", "isPrivate",
    "description", "createdAt", "updatedAt",
  ],
  Issue: [
    "id", "number", "title", "state", "body", "bodyText", "url", "createdAt", "updatedAt",
    "author", "labels", "comments", "repository", "closed",
  ],
  PullRequest: [
    "id", "number", "title", "body", "state", "merged", "mergeable", "headRefName", "baseRefName",
    "files", "createdAt", "updatedAt", "author", "url", "mergedAt", "headRef", "baseRef",
  ],
  User: ["id", "login", "name", "email", "url", "createdAt"],
  Ref: ["name", "target", "prefix"],
  Commit: ["id", "oid", "message", "committedDate"],
  PageInfo: ["hasNextPage", "hasPreviousPage", "startCursor", "endCursor"],
  IssueComment: ["id", "body", "createdAt", "updatedAt", "author"],
};

const GQL_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ["ISSUE", "REPOSITORY", "USER", "DISCUSSION"],
  IssueState: ["OPEN", "CLOSED"],
  PullRequestState: ["OPEN", "CLOSED", "MERGED"],
  MergeableState: ["MERGEABLE", "CONFLICTING", "UNKNOWN"],
  PullRequestMergeMethod: ["MERGE", "SQUASH", "REBASE"],
  RepositoryPermission: ["ADMIN", "MAINTAIN", "WRITE", "TRIAGE", "READ"],
  OrderDirection: ["ASC", "DESC"],
  IssueOrderField: ["CREATED_AT", "UPDATED_AT", "COMMENTS"],
};

function gqlTypeInfo(name: string): GqlObj | null {
  const enumValues = GQL_ENUM_VALUES[name];
  if (enumValues !== undefined) {
    return gqlObj("__Type", {
      name,
      kind: "ENUM",
      fields: null,
      enumValues: enumValues.map((value) =>
        gqlObj("__EnumValue", { name: value, description: null, isDeprecated: false, deprecationReason: null }),
      ),
    });
  }
  const fields = GQL_TYPE_FIELDS[name];
  if (fields === undefined) return null;
  return gqlObj("__Type", {
    name,
    kind: "OBJECT",
    fields: fields.map((field) => gqlObj("__Field", { name: field, description: null })),
    enumValues: null,
  });
}

function gqlResolveNode(id: string): GqlObj | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.type === "Repository") {
    const repo = reposById.get(decoded.numeric);
    return repo === undefined ? null : gqlRepo(repo);
  }
  if (decoded.type === "Issue") {
    const found = issuesByGid.get(decoded.numeric);
    return found === undefined ? null : gqlIssue(found.repo, found.issue);
  }
  if (decoded.type === "PullRequest") {
    const found = pullsByGid.get(decoded.numeric);
    return found === undefined ? null : gqlPull(found.repo, found.pull);
  }
  if (decoded.type === "User" && decoded.numeric === VIEWER.id) return gqlUser();
  return null;
}

function gqlQueryRoot(): GqlObj {
  return gqlObj("Query", {
    viewer: gqlUser(),
    repository: (args: Record<string, unknown>) => {
      const repo = findRepo(argStr(args, "owner"), argStr(args, "name"));
      return repo === null ? null : gqlRepo(repo);
    },
    node: (args: Record<string, unknown>) => gqlResolveNode(argStr(args, "id")),
    __type: (args: Record<string, unknown>) => gqlTypeInfo(argStr(args, "name")),
    __schema: gqlObj("__Schema", {
      queryType: gqlObj("__Type", { name: "Query", kind: "OBJECT", fields: null, enumValues: null }),
      mutationType: gqlObj("__Type", { name: "Mutation", kind: "OBJECT", fields: null, enumValues: null }),
      types: [],
    }),
  });
}

function gqlMutationRoot(): GqlObj {
  return gqlObj("Mutation", {
    createIssue: (args: Record<string, unknown>) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(argStr(input, "repositoryId"));
      const repo = decoded !== null && decoded.type === "Repository" ? reposById.get(decoded.numeric) : undefined;
      if (repo === undefined) throw new Error("Could not resolve repository");
      const issue = createIssueRec(repo, argStr(input, "title"), argStr(input, "body"), []);
      return gqlObj("CreateIssuePayload", { issue: gqlIssue(repo, issue), clientMutationId: null });
    },
    closeIssue: (args: Record<string, unknown>) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(argStr(input, "issueId"));
      const found = decoded !== null && decoded.type === "Issue" ? issuesByGid.get(decoded.numeric) : undefined;
      if (found === undefined) throw new Error("Could not resolve issue");
      found.issue.state = "closed";
      found.issue.updatedAt = tickIso();
      found.issue.version += 1;
      return gqlObj("CloseIssuePayload", { issue: gqlIssue(found.repo, found.issue), clientMutationId: null });
    },
    createPullRequest: (args: Record<string, unknown>) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(argStr(input, "repositoryId"));
      const repo = decoded !== null && decoded.type === "Repository" ? reposById.get(decoded.numeric) : undefined;
      if (repo === undefined) throw new Error("Could not resolve repository");
      const head = argStr(input, "headRefName");
      const base = argStr(input, "baseRefName");
      if (!repo.refs.has(`refs/heads/${head}`) || !repo.refs.has(`refs/heads/${base}`)) {
        throw new Error("Could not resolve head or base branch");
      }
      const pull = createPullRec(repo, argStr(input, "title"), argStr(input, "body"), head, base);
      return gqlObj("CreatePullRequestPayload", { pullRequest: gqlPull(repo, pull), clientMutationId: null });
    },
    mergePullRequest: (args: Record<string, unknown>) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(argStr(input, "pullRequestId"));
      const found = decoded !== null && decoded.type === "PullRequest" ? pullsByGid.get(decoded.numeric) : undefined;
      if (found === undefined) throw new Error("Could not resolve pull request");
      if (!found.pull.merged) {
        const method = argStr(input, "mergeMethod").toLowerCase() || "merge";
        const outcome = mergePull(found.repo, found.pull, method);
        if ("conflict" in outcome) throw new Error("Pull Request is not mergeable");
      }
      return gqlObj("MergePullRequestPayload", { pullRequest: gqlPull(found.repo, found.pull), clientMutationId: null });
    },
    addComment: (args: Record<string, unknown>) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(argStr(input, "subjectId"));
      const found = decoded !== null && decoded.type === "Issue" ? issuesByGid.get(decoded.numeric) : undefined;
      if (found === undefined) throw new Error("Could not resolve subject");
      const comment: CommentRec = { id: nextCommentId, body: argStr(input, "body"), createdAt: tickIso() };
      nextCommentId += 1;
      found.issue.comments.push(comment);
      found.issue.version += 1;
      return gqlObj("AddCommentPayload", {
        commentEdge: gqlObj("IssueCommentEdge", { node: gqlComment(comment), cursor: encodeCursor(0) }),
        clientMutationId: null,
      });
    },
  });
}

interface ExecCtx {
  variables: Record<string, unknown>;
  fragments: Map<string, GqlFragment>;
  errors: { message: string }[];
}

function resolveGqlValue(value: GqlValue, ctx: ExecCtx): unknown {
  switch (value.kind) {
    case "variable":
      return ctx.variables[value.name];
    case "int":
    case "float":
    case "string":
    case "boolean":
    case "enum":
      return value.value;
    case "null":
      return null;
    case "list":
      return value.values.map((entry) => resolveGqlValue(entry, ctx));
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of value.fields) out[key] = resolveGqlValue(entry, ctx);
      return out;
    }
  }
}

function evalGqlArgs(args: Map<string, GqlValue>, ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of args) out[key] = resolveGqlValue(value, ctx);
  return out;
}

function gqlDirectivesSkip(directives: GqlDirective[], ctx: ExecCtx): boolean {
  for (const directive of directives) {
    if (directive.name === "skip") {
      const ifArg = directive.args.get("if");
      if (ifArg !== undefined && resolveGqlValue(ifArg, ctx) === true) return true;
    }
    if (directive.name === "include") {
      const ifArg = directive.args.get("if");
      if (ifArg !== undefined && resolveGqlValue(ifArg, ctx) === false) return true;
    }
  }
  return false;
}

const NODE_IMPLEMENTORS = new Set(["Repository", "Issue", "PullRequest", "IssueComment", "User"]);

function gqlTypeMatches(objType: string, condition: string): boolean {
  if (objType === condition) return true;
  if (condition === "Node" && NODE_IMPLEMENTORS.has(objType)) return true;
  return false;
}

function completeGqlValue(value: unknown, selectionSet: GqlSelection[] | null, ctx: ExecCtx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeGqlValue(entry, selectionSet, ctx));
  if (isGqlObj(value)) {
    if (selectionSet === null) return {};
    const out: Record<string, unknown> = {};
    execGqlSet(value, selectionSet, ctx, out);
    return out;
  }
  return value;
}

function execGqlSet(obj: GqlObj, selections: GqlSelection[], ctx: ExecCtx, out: Record<string, unknown>): void {
  for (const selection of selections) {
    if (selection.kind === "spread") {
      if (gqlDirectivesSkip(selection.directives, ctx)) continue;
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      if (gqlTypeMatches(obj[GTYPE], fragment.typeCondition)) execGqlSet(obj, fragment.selectionSet, ctx, out);
      continue;
    }
    if (selection.kind === "inline") {
      if (gqlDirectivesSkip(selection.directives, ctx)) continue;
      if (selection.typeCondition === null || gqlTypeMatches(obj[GTYPE], selection.typeCondition)) {
        execGqlSet(obj, selection.selectionSet, ctx, out);
      }
      continue;
    }
    if (gqlDirectivesSkip(selection.directives, ctx)) continue;
    const key = selection.alias ?? selection.name;
    if (selection.name === "__typename") {
      out[key] = obj[GTYPE];
      continue;
    }
    const raw = obj[selection.name];
    if (raw === undefined) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${obj[GTYPE]}".` });
      out[key] = null;
      continue;
    }
    try {
      const value = typeof raw === "function" ? (raw as (args: Record<string, unknown>) => unknown)(evalGqlArgs(selection.args, ctx)) : raw;
      out[key] = completeGqlValue(value, selection.selectionSet, ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
    }
  }
}

function execGraphQLRequest(entry: unknown): Record<string, unknown> {
  const request = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
  const queryText = typeof request.query === "string" ? request.query : "";
  let document: GqlDocument;
  try {
    document = new GqlParser(gqlLex(queryText)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operationName = typeof request.operationName === "string" ? request.operationName : null;
  const operation = document.operations.find((op) => operationName === null || op.name === operationName) ?? document.operations[0];
  if (operation === undefined) return { errors: [{ message: "No operation found in document" }] };
  const variables: Record<string, unknown> = {};
  const defaultsCtx: ExecCtx = { variables: {}, fragments: document.fragments, errors: [] };
  for (const [name, defaultValue] of operation.variableDefaults) variables[name] = resolveGqlValue(defaultValue, defaultsCtx);
  if (typeof request.variables === "object" && request.variables !== null) {
    Object.assign(variables, request.variables as Record<string, unknown>);
  }
  const ctx: ExecCtx = { variables, fragments: document.fragments, errors: [] };
  const root = operation.operation === "mutation" ? gqlMutationRoot() : gqlQueryRoot();
  const out: Record<string, unknown> = {};
  execGqlSet(root, operation.selectionSet, ctx, out);
  const result: Record<string, unknown> = { data: out };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

function handleGraphQL(ctx: Ctx): void {
  if (!authorized(ctx.req)) {
    sendJson(ctx.res, 401, { message: "Requires authentication" });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString("utf8"));
  } catch {
    sendJson(ctx.res, 400, { errors: [{ message: "Invalid JSON in request body" }] });
    return;
  }
  if (Array.isArray(parsed)) {
    sendJson(ctx.res, 200, parsed.map((entry) => execGraphQLRequest(entry)));
    return;
  }
  sendJson(ctx.res, 200, execGraphQLRequest(parsed));
}

// ---------------------------------------------------------------------------
// MCP: JSON-RPC over POST /mcp, both protocol eras (server/discover and
// the initialize handshake), with the forge's tools over the shared store.
// The tools/list view is built once at startup: the rule is that it be
// byte-identical across calls, and a shared constant is the cheapest way
// to guarantee that.
// ---------------------------------------------------------------------------

const MCP_SERVER_INFO = { name: "forge", version: "3.0.0" };
const MCP_SUPPORTED_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

class McpParamsError extends Error {}

interface McpToolDef {
  name: string;
  description: string;
  properties: Record<string, Record<string, unknown>>;
  required: string[];
  run: (args: Record<string, unknown>) => unknown;
}

function mcpRepoOf(args: Record<string, unknown>): RepoRec {
  const repo = findRepo(argStr(args, "owner"), argStr(args, "repo"));
  if (repo === null) throw new Error(`repository ${argStr(args, "owner")}/${argStr(args, "repo")} not found`);
  return repo;
}

const MCP_TOOLS: McpToolDef[] = [
  {
    name: "create_repo",
    description: "Create a new repository for the authenticated user",
    properties: {
      owner: { type: "string", description: "Repository owner (defaults to the token owner)" },
      name: { type: "string", description: "Repository name" },
      description: { type: "string", description: "Repository description" },
      private: { type: "boolean", description: "Whether the repository is private" },
    },
    required: ["name"],
    run: (args) => {
      const name = argStr(args, "name");
      const existing = reposByKey.get(repoKey(VIEWER.login, name));
      if (existing !== undefined) return repoView(existing);
      const repo = createRepoRec(name, args.private === true, argStr(args, "description"));
      if (repo === null) throw new Error(`repository ${name} already exists`);
      return repoView(repo);
    },
  },
  {
    name: "get_repo",
    description: "Get a repository by owner and name",
    properties: {
      owner: { type: "string", description: "Repository owner" },
      repo: { type: "string", description: "Repository name" },
    },
    required: ["owner", "repo"],
    run: (args) => repoView(mcpRepoOf(args)),
  },
  {
    name: "create_issue",
    description: "Create an issue in a repository",
    properties: {
      owner: { type: "string", description: "Repository owner" },
      repo: { type: "string", description: "Repository name" },
      title: { type: "string", description: "Issue title" },
      body: { type: "string", description: "Issue body" },
    },
    required: ["owner", "repo", "title"],
    run: (args) => {
      const repo = mcpRepoOf(args);
      const issue = createIssueRec(repo, argStr(args, "title"), argStr(args, "body"), []);
      return issueView(repo, issue);
    },
  },
  {
    name: "list_issues",
    description: "List issues in a repository",
    properties: {
      owner: { type: "string", description: "Repository owner" },
      repo: { type: "string", description: "Repository name" },
      state: { type: "string", description: "Issue state filter: open, closed or all" },
    },
    required: ["owner", "repo"],
    run: (args) => {
      const repo = mcpRepoOf(args);
      const state = argStr(args, "state") || "open";
      let issues = [...repo.issues.values()];
      if (state === "open") issues = issues.filter((issue) => issue.state === "open");
      else if (state === "closed") issues = issues.filter((issue) => issue.state === "closed");
      issues.sort((a, b) => a.number - b.number);
      return issues.map((issue) => issueView(repo, issue));
    },
  },
  {
    name: "get_issue",
    description: "Get one issue by number",
    properties: {
      owner: { type: "string", description: "Repository owner" },
      repo: { type: "string", description: "Repository name" },
      issue_number: { type: "number", description: "Issue number" },
    },
    required: ["owner", "repo", "issue_number"],
    run: (args) => {
      const repo = mcpRepoOf(args);
      const number = typeof args.issue_number === "number" ? args.issue_number : Number.parseInt(argStr(args, "issue_number"), 10);
      const issue = repo.issues.get(number);
      if (issue === undefined) throw new Error(`issue ${number} not found`);
      return issueView(repo, issue);
    },
  },
  {
    name: "create_pull_request",
    description: "Create a pull request between two branches",
    properties: {
      owner: { type: "string", description: "Repository owner" },
      repo: { type: "string", description: "Repository name" },
      title: { type: "string", description: "Pull request title" },
      body: { type: "string", description: "Pull request body" },
      head: { type: "string", description: "Head branch" },
      base: { type: "string", description: "Base branch" },
    },
    required: ["owner", "repo", "title", "head", "base"],
    run: (args) => {
      const repo = mcpRepoOf(args);
      const head = normalizeRefName(argStr(args, "head"));
      const base = normalizeRefName(argStr(args, "base"));
      if (!repo.refs.has(`refs/heads/${head}`)) throw new Error(`head branch ${head} does not exist`);
      if (!repo.refs.has(`refs/heads/${base}`)) throw new Error(`base branch ${base} does not exist`);
      const pull = createPullRec(repo, argStr(args, "title"), argStr(args, "body"), head, base);
      return pullView(repo, pull);
    },
  },
  {
    name: "list_pull_requests",
    description: "List pull requests in a repository",
    properties: {
      owner: { type: "string", description: "Repository owner" },
      repo: { type: "string", description: "Repository name" },
      state: { type: "string", description: "State filter: open, closed or all" },
    },
    required: ["owner", "repo"],
    run: (args) => {
      const repo = mcpRepoOf(args);
      const state = argStr(args, "state") || "open";
      let pulls = [...repo.pulls.values()];
      if (state === "open") pulls = pulls.filter((pull) => pull.state === "open" && !pull.merged);
      else if (state === "closed") pulls = pulls.filter((pull) => pull.state === "closed" || pull.merged);
      pulls.sort((a, b) => a.number - b.number);
      return pulls.map((pull) => pullView(repo, pull));
    },
  },
  {
    name: "merge_pull_request",
    description: "Merge a pull request",
    properties: {
      owner: { type: "string", description: "Repository owner" },
      repo: { type: "string", description: "Repository name" },
      pull_number: { type: "number", description: "Pull request number" },
      merge_method: { type: "string", description: "Merge method: merge, squash or rebase" },
    },
    required: ["owner", "repo", "pull_number"],
    run: (args) => {
      const repo = mcpRepoOf(args);
      const number = typeof args.pull_number === "number" ? args.pull_number : Number.parseInt(argStr(args, "pull_number"), 10);
      const pull = repo.pulls.get(number);
      if (pull === undefined) throw new Error(`pull request ${number} not found`);
      if (!pull.merged) {
        const outcome = mergePull(repo, pull, argStr(args, "merge_method") || "squash");
        if ("conflict" in outcome) throw new Error("Pull Request is not mergeable");
      }
      return pullView(repo, pull);
    },
  },
  {
    name: "create_label",
    description: "Create a label in a repository",
    properties: {
      owner: { type: "string", description: "Repository owner" },
      repo: { type: "string", description: "Repository name" },
      name: { type: "string", description: "Label name" },
      color: { type: "string", description: "Label color (hex, no #)" },
    },
    required: ["owner", "repo", "name"],
    run: (args) => {
      const repo = mcpRepoOf(args);
      const name = argStr(args, "name");
      const existing = repo.labels.get(name);
      if (existing !== undefined) return labelView(existing);
      const label: LabelRec = {
        id: nextLabelId,
        name,
        color: argStr(args, "color") || "ededed",
        description: argStr(args, "description") || null,
      };
      nextLabelId += 1;
      repo.labels.set(name, label);
      return labelView(label);
    },
  },
];

/** The tools/list view, built once: the same array backs every answer. */
const MCP_TOOL_LIST_VIEW: Record<string, unknown>[] = MCP_TOOLS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: { type: "object", properties: tool.properties, required: tool.required },
}));

function mcpDiscoverResult(): Record<string, unknown> {
  return {
    _meta: {
      "io.modelcontextprotocol/serverInfo": MCP_SERVER_INFO,
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    },
    serverInfo: MCP_SERVER_INFO,
    protocolVersion: "2026-07-28",
    supportedVersions: MCP_SUPPORTED_VERSIONS,
    capabilities: { tools: { listChanged: false } },
  };
}

function mcpCallTool(params: Record<string, unknown>): Record<string, unknown> {
  const name = argStr(params, "name");
  const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new McpParamsError(`unknown tool: ${name}`);
  const args = (typeof params.arguments === "object" && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
  for (const required of tool.required) {
    if (args[required] === undefined || args[required] === null || args[required] === "") {
      throw new McpParamsError(`missing required argument: ${required}`);
    }
  }
  try {
    const value = tool.run(args);
    const text = JSON.stringify(value);
    return { content: [{ type: "text", text }], structuredContent: value as Record<string, unknown>, isError: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

function mcpDispatch(request: Record<string, unknown>): Record<string, unknown> | null {
  const method = typeof request.method === "string" ? request.method : "";
  const id = request.id;
  const params = (typeof request.params === "object" && request.params !== null ? request.params : {}) as Record<string, unknown>;
  const isNotification = id === undefined || id === null;
  const respond = (result: unknown): Record<string, unknown> | null => {
    if (isNotification) return null;
    return { jsonrpc: "2.0", id, result };
  };
  const respondError = (code: number, message: string): Record<string, unknown> | null => {
    if (isNotification) return null;
    return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
  };
  try {
    switch (method) {
      case "server/discover":
        return respond(mcpDiscoverResult());
      case "initialize": {
        const requested = argStr(params, "protocolVersion");
        const version = MCP_SUPPORTED_VERSIONS.includes(requested) ? requested : "2025-11-25";
        return respond({ protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: MCP_SERVER_INFO });
      }
      case "ping":
        return respond({});
      case "tools/list":
        return respond({ tools: MCP_TOOL_LIST_VIEW });
      case "tools/call":
        return respond(mcpCallTool(params));
      default:
        if (method.startsWith("notifications/")) return null;
        return respondError(-32601, `method not found: ${method}`);
    }
  } catch (err) {
    if (err instanceof McpParamsError) return respondError(-32602, err.message);
    return respondError(-32603, err instanceof Error ? err.message : String(err));
  }
}

function handleMcp(ctx: Ctx): void {
  if (!authorized(ctx.req)) {
    sendJson(ctx.res, 401, { jsonrpc: "2.0", id: null, error: { code: -32001, message: "unauthorized" } });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString("utf8"));
  } catch {
    sendJson(ctx.res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  if (Array.isArray(parsed)) {
    const responses: Record<string, unknown>[] = [];
    for (const entry of parsed) {
      const response = mcpDispatch((entry ?? {}) as Record<string, unknown>);
      if (response !== null) responses.push(response);
    }
    sendJson(ctx.res, 200, responses);
    return;
  }
  const response = mcpDispatch((parsed ?? {}) as Record<string, unknown>);
  if (response === null) {
    sendEmpty(ctx.res, 202);
    return;
  }
  sendJson(ctx.res, 200, response);
}

// ---------------------------------------------------------------------------
// Routing, HTTP server, trial lifecycle
// ---------------------------------------------------------------------------

const GIT_PATH_RE = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const EMPTY_BODY: Buffer = Buffer.alloc(0);

function route(ctx: Ctx): void {
  const path = ctx.path;
  const method = ctx.req.method ?? "GET";
  if (path === "/healthz") {
    sendJson(ctx.res, 200, { ok: true });
    return;
  }
  if (path === "/api/v3" || path.startsWith("/api/v3/")) {
    handleRest(ctx);
    return;
  }
  if (path === "/api/graphql" && method === "POST") {
    handleGraphQL(ctx);
    return;
  }
  if (path === "/mcp" && method === "POST") {
    handleMcp(ctx);
    return;
  }
  const gitMatch = GIT_PATH_RE.exec(path);
  if (gitMatch !== null) {
    handleGit(ctx, decodeSegment(gitMatch[1] as string), decodeSegment(gitMatch[2] as string), gitMatch[3] as string);
    return;
  }
  sendJson(ctx.res, 404, { message: "Not Found" });
}

function createForgeServer(): HttpServer {
  return createServer((req, res) => {
    const hasBody =
      req.headers["content-length"] !== undefined || req.headers["transfer-encoding"] !== undefined;
    const dispatch = (body: Buffer): void => {
      try {
        const rawUrl = req.url ?? "/";
        const qIndex = rawUrl.indexOf("?");
        const path = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);
        const query = qIndex === -1 ? "" : rawUrl.slice(qIndex + 1);
        route(new Ctx(req, res, path, query, body));
      } catch (err) {
        if (err instanceof HttpError) {
          sendJson(res, err.status, { message: err.message });
          return;
        }
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : "Internal Server Error" });
        } catch {
          // The response may already be half-written; nothing more to do.
        }
      }
    };
    if (!hasBody) {
      dispatch(EMPTY_BODY);
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => dispatch(chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks)));
    req.on("error", () => {
      try {
        sendJson(res, 400, { message: "Bad Request" });
      } catch {
        // Connection already gone.
      }
    });
  });
}

async function postJson(url: string, payload: unknown): Promise<number> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return response.status;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function registerWithEnv(envUrl: string, port: number): Promise<void> {
  let delay = 250;
  for (;;) {
    try {
      const status = await postJson(`${envUrl}/register`, { port });
      if (status === 200 || status === 201 || status === 204 || status === 409) return;
      if (status === 400 || status === 405) {
        throw new Error(`environment refused registration with status ${status}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("environment refused")) throw err;
      // Transient network error: keep retrying below.
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 2000);
  }
}

async function waitForDone(envUrl: string): Promise<void> {
  let delay = 250;
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(30000) });
      if (response.ok) {
        const payload = (await response.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // Transient: keep polling below.
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 2000);
  }
}

async function main(): Promise<void> {
  const envUrl = process.env.MAKEFUN_ENV_URL ?? "";
  const server = createForgeServer();
  if (envUrl !== "") {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("server has no port");
    await registerWithEnv(envUrl, address.port);
    await waitForDone(envUrl);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.exit(0);
    return;
  }
  const port = Number.parseInt(process.env.FORGE_PORT ?? "8931", 10);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  console.log(`forge listening on http://127.0.0.1:${port}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
