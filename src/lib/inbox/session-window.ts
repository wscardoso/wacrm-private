import { differenceInHours } from "date-fns";
import type { Message } from "@/types";

export interface SessionInfo {
  expired: boolean;
  /** English label, kept for existing callers/tests. */
  remaining: string;
  /** Structured form of `remaining`, so the UI can localize it. */
  state: "empty" | "no_customer" | "expired" | "active";
  hoursLeft?: number;
  minutesLeft?: number;
}

export function computeSessionInfo(messages: Message[], now: Date): SessionInfo {
  if (!messages.length) return { expired: false, remaining: "", state: "empty" };

  const lastCustomerMsg = [...messages]
    .reverse()
    .find((m) => m.sender_type === "customer");

  if (!lastCustomerMsg)
    return { expired: true, remaining: "No customer messages", state: "no_customer" };

  const hoursSince = differenceInHours(now, new Date(lastCustomerMsg.created_at));
  const expired = hoursSince >= 24;

  if (expired) return { expired: true, remaining: "Expired", state: "expired" };

  const hoursLeft = 24 - hoursSince;
  const remaining =
    hoursLeft >= 1
      ? `${Math.floor(hoursLeft)}h remaining`
      : `${Math.floor(hoursLeft * 60)}m remaining`;

  return hoursLeft >= 1
    ? { expired, remaining, state: "active", hoursLeft: Math.floor(hoursLeft) }
    : { expired, remaining, state: "active", minutesLeft: Math.floor(hoursLeft * 60) };
}
