/** keys.ts — pure: recognise work items in evidence links and turn them into stable thread keys. */

const JIRA = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

/**
 * jira:KEY-1 from a Jira browse URL (or a board URL with selectedIssue=), pr:owner/repo#n from a GitHub pull request,
 * doc:<host>/<id> from a Confluence page or a Google Docs/Sheets/Slides file. Anything else yields no key.
 */
export function keyOfLink(link: string): string | null {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname;

  if (host === "github.com" || host === "www.github.com") {
    const m = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/.exec(path);
    return m ? `pr:${m[1]!.toLowerCase()}/${m[2]!.toLowerCase()}#${m[3]}` : null;
  }
  if (host === "docs.google.com") {
    const m = /^\/(?:document|spreadsheets|presentation)\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)/.exec(path);
    return m ? `doc:${host}/${m[1]}` : null;
  }
  // Atlassian: Confluence lives under /wiki, Jira under /browse (or a board's selectedIssue).
  const browse = /\/browse\/([A-Za-z][A-Za-z0-9]*-\d+)(?:[/?#]|$)/.exec(path);
  if (browse && JIRA.test(browse[1]!)) return `jira:${browse[1]!.toUpperCase()}`;
  const selected = url.searchParams.get("selectedIssue");
  if (selected !== null && JIRA.test(selected)) return `jira:${selected.toUpperCase()}`;
  const page = /\/wiki\/(?:spaces\/[^/]+\/)?(?:pages|whiteboards|database)\/(\d+)/.exec(path);
  if (page) return `doc:${host}/${page[1]}`;
  const pageId = url.searchParams.get("pageId");
  if (path.includes("/wiki/") && pageId !== null && /^\d+$/.test(pageId)) return `doc:${host}/${pageId}`;
  return null;
}

/** The unique keys of a set of evidence links, in order of appearance. */
export function extractKeys(evidenceLinks: ReadonlyArray<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const link of evidenceLinks) {
    if (typeof link !== "string" || link === "") continue;
    const key = keyOfLink(link);
    if (key !== null && !out.includes(key)) out.push(key);
  }
  return out;
}
