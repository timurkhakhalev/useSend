"use client";

import { useState } from "react";
import { CheckIcon, PlusIcon } from "lucide-react";
import { Button } from "@usesend/ui/src/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@usesend/ui/src/dialog";
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
} from "@usesend/ui/src/dropdown-menu";
import { Input } from "@usesend/ui/src/input";
import { Spinner } from "@usesend/ui/src/spinner";
import { toast } from "@usesend/ui/src/toaster";
import { useTeam } from "~/providers/team-context";
import { api } from "~/trpc/react";

/** Team list for the user menu: pick the active team or start a new one. */
export function TeamMenuItems({ onCreateTeam }: { onCreateTeam: () => void }) {
  const { teams, currentTeam, switchTeam } = useTeam();

  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel className="text-xs text-muted-foreground">
        Teams
      </DropdownMenuLabel>
      {teams.map((team) => (
        <DropdownMenuItem
          key={team.id}
          onSelect={() => {
            if (team.id !== currentTeam?.id) switchTeam(team.id);
          }}
        >
          <CheckIcon
            className={team.id === currentTeam?.id ? "" : "invisible"}
          />
          <span className="truncate">{team.name}</span>
        </DropdownMenuItem>
      ))}
      <DropdownMenuItem onSelect={onCreateTeam}>
        <PlusIcon />
        New team
      </DropdownMenuItem>
    </DropdownMenuGroup>
  );
}

export function CreateTeamDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState("");
  const { switchTeam } = useTeam();
  const createTeam = api.team.createTeam.useMutation();

  function onSubmit(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length < 2) {
      toast.error("Team name must be at least 2 characters.");
      return;
    }

    createTeam.mutate(
      { name: trimmed },
      {
        onSuccess: (team) => {
          if (team) switchTeam(team.id);
        },
        onError: (e) => toast.error(e.message),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-6">
          <DialogHeader>
            <DialogTitle>New team</DialogTitle>
            <DialogDescription>
              A team has its own domains, API keys, suppression list and rate
              limit.
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            placeholder="Team name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <DialogFooter>
            <Button type="submit" disabled={createTeam.isPending}>
              {createTeam.isPending ? <Spinner className="h-5 w-5" /> : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
