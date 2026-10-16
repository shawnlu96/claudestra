import { Chat } from "@/features/chat/components/chat";
import { MachineGate } from "@/features/machines/machine-gate";
import { QuotaNotice } from "@/features/quota/quota-notice";

export default function ChatPage() {
  return (
    <MachineGate>
      <Chat notices={<QuotaNotice embedded />} />
    </MachineGate>
  );
}
