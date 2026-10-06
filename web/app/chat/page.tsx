import { Chat } from "@/features/chat/components/chat";
import { QuotaWarningBanner } from "@/features/lend/quota-warning-banner";
import { MachineGate } from "@/features/machines/machine-gate";
import { QuotaWallBanner } from "@/features/quota-wall/quota-wall-banner";

export default function ChatPage() {
  return (
    <MachineGate>
      <Chat />
      <QuotaWallBanner />
      <QuotaWarningBanner />
    </MachineGate>
  );
}
