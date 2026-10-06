/**
 * Azure entity names.
 *
 * **The good news is that a 7K qualified name is already a legal one.** A Service Bus entity segment
 * admits letters, digits, periods, hyphens and underscores, so `acme.shop.commands` deploys under the
 * name the model gave it and the name in a trace is the name in the portal. No mangling, nothing to
 * map back.
 *
 * **The bad news is the length.** A namespace, a subscription or a rule name is capped at 50
 * characters, and 7K places no such limit — so a model can name something this cannot deploy. That is
 * refused rather than truncated, because two truncated names that collide would deploy one entity where
 * the model declared two, and nothing downstream would notice.
 */

import type { Decl, NodeId } from "@sevenk/core";

/** A namespace, subscription or rule name. The entity *path* may be longer; a segment may not. */
export const MAX_NAME = 50;

/** The whole path of an entity, parents included. */
export const MAX_PATH = 260;

/** The characters a Service Bus entity segment admits. */
const LEGAL = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const qualified = (id: NodeId): string => (id.pkg === "" ? id.name : `${id.pkg}.${id.name}`);

export const qnameOf = (decl: Decl): string => qualified(decl.id);

export interface NameProblem {
  readonly at: string;
  readonly declared: string;
  readonly because: string;
}

/** A Bicep symbolic name: an identifier, which a dotted 7K name is not. */
export const symbol = (text: string): string => {
  const parts = text
    .split(/[^A-Za-z0-9]+/)
    .filter((p) => p !== "")
    .map((p, i) => (i === 0 ? p[0]!.toLowerCase() + p.slice(1) : p[0]!.toUpperCase() + p.slice(1)));
  const joined = parts.join("");
  return /^[0-9]/.test(joined) ? `_${joined}` : joined;
};

/**
 * Checks an entity name against what Azure will take.
 *
 * `kind` is only for the message: a reader needs to know whether to rename a pipe or a subscription,
 * and the two are fixed in different places in the model.
 */
export function checkName(
  name: string,
  kind: "queue" | "topic" | "hub" | "subscription" | "rule",
  at: string,
): NameProblem | undefined {
  if (!LEGAL.test(name)) {
    return {
      at,
      declared: `the name \`${name}\``,
      because:
        `A Service Bus name admits letters, digits, periods, hyphens and underscores, and must begin ` +
        `with a letter or a digit. Rename it in the model.`,
    };
  }

  // Every *segment* is capped at 50, and the whole path at 260. A queue or topic name may hold
  // several segments separated by `/`; a 7K name holds one, so in practice the 50 is the limit that
  // bites — which is the opposite of what the 260 in the documentation suggests at a glance.
  const segments = name.split("/");
  const tooLong = segments.find((segment) => segment.length > MAX_NAME);
  if (tooLong !== undefined) {
    return {
      at,
      declared: `the ${kind} name \`${name}\` (${tooLong.length} characters)`,
      because:
        `Azure caps every segment of an entity name at ${MAX_NAME}. Truncating would risk two names ` +
        `becoming one, which would deploy a single entity where the model declares two — so this is ` +
        `refused. Shorten the name in the model, or give the run a \`names\` rule for it.`,
    };
  }

  if (name.length > MAX_PATH) {
    return {
      at,
      declared: `the ${kind} path \`${name}\` (${name.length} characters)`,
      because: `Azure caps a whole entity path at ${MAX_PATH}.`,
    };
  }

  return undefined;
}
