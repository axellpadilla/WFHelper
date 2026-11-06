#!/usr/bin/env node
// Posts a release changelog to Discord. Plain content spans the full chat width
// but caps at 2000 chars, so a long body is split at blank lines (else line
// breaks) into follow-up posts instead of being cut off.
// Env: DISCORD_WEBHOOK_URL, TITLE, TAG, URL, BODY, ROLE_ID, DRY_RUN=true.

import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const CONTENT_LIMIT = 2000;
const MAX_MESSAGES = 10;
const USERNAME = "WFHelper Releases";
const FALLBACK_BODY = "A new version of WFHelper is available - see the release for details.";

function normalizeBody(body) {
  return String(body ?? "")
    .replace(/\r\n?/g, "\n")
    .trim();
}

// Splits off a leading piece that fits `limit`: at the last blank line, else the
// last line break, else a hard cut for a single overlong line.
function takeChunk(text, limit) {
  if (text.length <= limit) return [text, ""];
  const head = text.slice(0, limit);
  let cut = head.lastIndexOf("\n\n");
  if (cut < 1) cut = head.lastIndexOf("\n");
  if (cut < 1) cut = limit;
  return [text.slice(0, cut).trimEnd(), text.slice(cut).trimStart()];
}

export function buildMessages({ title, tag, url, body, roleId }) {
  const name = title || tag;
  const mention = roleId ? ` <@&${roleId}>` : "";
  const header = `## [WFHelper ${name}](${url}) is out 🎉${mention}\n`;
  const footer = `\n-# [Release notes](${url}) · Download at wfhelper.com`;
  const more = `\n\n**[Full changelog →](${url})**`;
  const messages = [];
  let rest = normalizeBody(body) || FALLBACK_BODY;
  while (rest.length > 0) {
    const first = messages.length === 0;
    const capped = messages.length === MAX_MESSAGES - 1;
    const room =
      CONTENT_LIMIT - (first ? header.length : 0) - footer.length - (capped ? more.length : 0);
    let [chunk, remaining] = takeChunk(rest, room);
    if (capped && remaining) {
      chunk += more;
      remaining = "";
    }
    const last = remaining.length === 0;
    messages.push({
      content: (first ? header : "") + chunk + (last ? footer : ""),
      // Only the first post pings; allowed_mentions keeps the notes from pinging.
      allowedMentions: first && roleId ? { roles: [roleId] } : { parse: [] },
    });
    rest = remaining;
  }
  for (const message of messages) {
    if (message.content.length > CONTENT_LIMIT) {
      throw new Error(
        `Message content is ${message.content.length} chars; Discord rejects over 2000.`,
      );
    }
  }
  return messages;
}

async function post(webhookUrl, message) {
  const target = new URL(webhookUrl);
  // wait=true makes Discord confirm creation, so sequential posts keep their order.
  target.searchParams.set("wait", "true");
  const body = JSON.stringify({
    username: USERNAME,
    content: message.content,
    allowed_mentions: message.allowedMentions,
  });
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (response.ok) return;
    if (response.status === 429) {
      const data = await response.json().catch(() => ({}));
      await sleep((Number(data.retry_after) || 1) * 1000);
      continue;
    }
    throw new Error(
      `Discord returned ${response.status}: ${(await response.text()).slice(0, 300)}`,
    );
  }
  throw new Error("Discord kept rate limiting the webhook");
}

async function main() {
  const env = process.env;
  if (!env.DISCORD_WEBHOOK_URL) {
    // A fork or an unconfigured deployment has nothing to announce, which is not
    // a failed build. The dry run exists only to prove the secret is wired, so
    // it still reports the missing secret.
    if (env.DRY_RUN === "true") {
      console.error(
        "::error::DISCORD_WEBHOOK_URL secret is missing/empty - Discord announcement NOT sent.",
      );
      process.exit(1);
    }
    console.log("DISCORD_WEBHOOK_URL is not configured; skipping the announcement.");
    return;
  }
  const messages = buildMessages({
    title: env.TITLE,
    tag: env.TAG,
    url: env.URL,
    body: env.BODY,
    roleId: env.ROLE_ID,
  });
  const sizes = messages.map((message) => message.content.length).join(", ");
  if (env.DRY_RUN === "true") {
    console.log("Webhook secret is set (non-empty). Dry run - nothing posted.");
    console.log(
      env.ROLE_ID
        ? `Release role ping configured (id ends ...${env.ROLE_ID.slice(-4)}).`
        : "No release role ping configured (DISCORD_RELEASE_ROLE_ID unset).",
    );
    console.log(`Would post ${messages.length} message(s): ${sizes} chars.`);
    return;
  }
  for (const [index, message] of messages.entries()) {
    await post(env.DISCORD_WEBHOOK_URL, message);
    console.log(
      `Posted message ${index + 1}/${messages.length} (${message.content.length} chars).`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
