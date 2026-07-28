import { differenceInHours } from "date-fns";
import type { Message } from "@/types";

export interface SessionInfo {
  expired: boolean;
  remaining: string;
}

export function computeSessionInfo(messages: Message[], now: Date): SessionInfo {
  if (!messages.length) return { expired: false, remaining: "" };

  const lastCustomerMsg = [...messages]
    .reverse()
    .find((m) => m.sender_type === "customer");

  if (!lastCustomerMsg) return { expired: true, remaining: "No customer messages" };

  const hoursSince = differenceInHours(now, new Date(lastCustomerMsg.created_at));
  const expired = hoursSince >= 24;

  if (expired) return { expired: true, remaining: "Expired" };

  const hoursLeft = 24 - hoursSince;
  const remaining =
    hoursLeft >= 1
      ? `${Math.floor(hoursLeft)}h remaining`
      : `${Math.floor(hoursLeft * 60)}m remaining`;

  return { expired, remaining };
}
