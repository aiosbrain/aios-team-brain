import "server-only";
import type { GovernedConsumer } from "@/lib/actions/governed";
import { recordGovernedDecision } from "@/lib/decisions/service";

export const decisionConsumer: GovernedConsumer = {
  type: "decision.record",
  execute: recordGovernedDecision,
};
