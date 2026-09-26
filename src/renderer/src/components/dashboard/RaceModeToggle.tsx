import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

const STORAGE_KEY = "vwd.raceMode";

// Race mode = the dark telemetry theme. On by default; the choice persists.
const initial = (): boolean => {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
};

export default function RaceModeToggle(): React.JSX.Element {
  const [race, setRace] = useState<boolean>(initial);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", race);
    try {
      window.localStorage.setItem(STORAGE_KEY, race ? "on" : "off");
    } catch {
      /* private mode etc. */
    }
  }, [race]);

  return (
    <Button
      variant="outline"
      size="icon"
      className="size-9 rounded-full"
      aria-pressed={race}
      aria-label={race ? "Race mode on (dark). Switch to light" : "Race mode off (light). Switch to dark"}
      title={race ? "Race mode (dark)" : "Light mode"}
      onClick={() => setRace((on) => !on)}
    >
      {race ? <Moon className="size-4" /> : <Sun className="size-4" />}
    </Button>
  );
}
