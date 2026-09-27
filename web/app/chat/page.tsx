import { Chat } from "@/features/chat/components/chat";
import { MachineGate } from "@/features/machines/machine-gate";

export default function ChatPage() {
  return (
    <MachineGate>
      <Chat />
    </MachineGate>
  );
}
