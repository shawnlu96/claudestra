import { MachineGate } from "@/features/machines/machine-gate";
import { TalkApp } from "@/features/talk/talk-app";

export default function TalkPage() {
  return (
    <MachineGate>
      <TalkApp />
    </MachineGate>
  );
}
