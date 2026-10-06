/**
 * A subscription's filter.
 *
 * This is the clause that earns the provider. `where envelope.priority < 5` has no home in a C#
 * handler — it became a comment there, because filtering happens before the handler runs — and here it
 * *is* the thing that does the filtering. The model says which messages a subscription wants and the
 * broker is what keeps the others away.
 *
 * Two filters come out of one subscription and both matter:
 *
 * - **The type filter.** A topic carries several message types and a subscription reacts to some of
 *   them. Without a filter every subscriber receives everything and each has to recognise and discard
 *   what is not its own — which is work, and a bug the first time somebody forgets. The types a
 *   subscription reacts to are in the model, so the filter is too.
 * - **The `where` filter**, over the envelope, which is what the model wrote it for (D56).
 *
 * **What it will not do is guess.** A `where` this cannot translate exactly becomes a loss and no
 * filter, which means the subscription receives more than the model says — stated, and strictly safer
 * than a filter that drops something it should have kept.
 */

import type { Operand, Predicate } from "@sevenk/core";

export interface Filter {
  readonly sql?: string;
  readonly why?: string;
}

/**
 * How a message's type reaches a filter.
 *
 * `sys.Label` is Service Bus's own property for it, which a sender sets to the message's qualified 7K
 * name. That convention has to hold on both sides, so it is stated here and in the comment the
 * template carries.
 */
export const LABEL = "sys.Label";

const literal = (value: unknown): string => {
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
};

/** The filter matching exactly the message types a subscription reacts to. */
export const typeFilter = (types: readonly string[]): string =>
  types.length === 1
    ? `${LABEL} = ${literal(types[0])}`
    : `${LABEL} IN (${types.map(literal).join(", ")})`;

const OPS: Readonly<Record<string, string>> = {
  "==": "=",
  "!=": "<>",
  "<": "<",
  "<=": "<=",
  ">": ">",
  ">=": ">=",
};

/**
 * A `where` predicate as a Service Bus SQL filter.
 *
 * Only over the envelope, which is also all 7K allows a `where` to read (D56) — so the restriction is
 * the language's and not this provider's. An envelope field travels as a message property of the same
 * name, which is the convention the generated comment states.
 */
export function whereFilter(predicate: Predicate): Filter {
  switch (predicate.p) {
    case "and":
    case "or": {
      const parts = predicate.operands.map(whereFilter);
      const failed = parts.find((p) => p.sql === undefined);
      if (failed !== undefined) return failed;
      const joiner = predicate.p === "and" ? " AND " : " OR ";
      return { sql: `(${parts.map((p) => p.sql).join(joiner)})` };
    }

    case "not": {
      const inner = whereFilter(predicate.operand);
      return inner.sql === undefined ? inner : { sql: `NOT (${inner.sql})` };
    }

    case "cmp": {
      const op = OPS[predicate.op];

      // `in` is a filter Service Bus has, over a literal list.
      if (predicate.op === "in") {
        const left = side(predicate.left);
        if (left.sql === undefined) return left;
        if (predicate.right.k !== "list") {
          return { why: "`in` needs a literal list on its right in a filter" };
        }
        return { sql: `${left.sql} IN (${predicate.right.values.map(literal).join(", ")})` };
      }

      if (op === undefined) {
        // `contains` is the one that looks translatable and is not: 7K's `contains` on a scope claim
        // means "holds this scope" over a space-separated list, and `LIKE '%x%'` would also match
        // `x-admin`. A filter that matches more than the model is a filter that lets something past.
        return {
          why:
            predicate.op === "contains"
              ? "`contains` means holding a whole element, and a `LIKE` would also match a longer one"
              : `the operator \`${predicate.op}\` has no filter equivalent`,
        };
      }

      const left = side(predicate.left);
      const right = side(predicate.right);
      if (left.sql === undefined) return left;
      if (right.sql === undefined) return right;
      return { sql: `${left.sql} ${op} ${right.sql}` };
    }

    default:
      return { why: "7K could not parse it" };
  }
}

function side(operand: Operand): Filter {
  switch (operand.k) {
    case "literal":
      return { sql: literal(operand.value) };
    case "envelope":
      // A message property, by the envelope field's own name. Nested paths do not exist as properties.
      return operand.path.length === 1
        ? { sql: operand.path[0]! }
        : {
            why:
              `\`envelope.${operand.path.join(".")}\` is nested, and a message property is flat — ` +
              `there is nothing for the filter to read`,
          };
    case "claim":
      return {
        why:
          "a claim is the sender's identity, which Service Bus authorises by role and does not put " +
          "on the message",
      };
    default:
      return { why: `a filter cannot read \`${operand.k}\`: only the envelope travels as properties` };
  }
}
