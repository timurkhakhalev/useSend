"use client";

import { createContext, useContext, useState, useEffect } from "react";
import { api } from "~/trpc/react";
import { ACTIVE_TEAM_COOKIE, parseActiveTeamId } from "~/lib/constants/team";

// Define the Team type based on the Prisma schema
type Team = {
  id: number;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  plan: "FREE" | "BASIC";
  stripeCustomerId?: string | null;
  billingEmail?: string | null;
};

interface TeamContextType {
  currentTeam: Team | null;
  teams: Team[];
  isLoading: boolean;
  currentRole: "ADMIN" | "MEMBER";
  currentIsAdmin: boolean;
  switchTeam: (teamId: number) => void;
}

const TeamContext = createContext<TeamContextType | undefined>(undefined);

/** Stores the active team and reloads the dashboard so every query refetches for it. */
export function switchTeam(teamId: number) {
  document.cookie = `${ACTIVE_TEAM_COOKIE}=${teamId}; path=/; max-age=31536000; samesite=lax`;
  window.location.assign("/dashboard");
}

export function TeamProvider({ children }: { children: React.ReactNode }) {
  const { data: teams, status } = api.team.getTeams.useQuery();
  const [activeTeamId, setActiveTeamId] = useState<number | undefined>();

  useEffect(() => {
    setActiveTeamId(parseActiveTeamId(document.cookie));
  }, []);

  // Same rule as `teamProcedure` on the server: the team from the cookie if
  // the user is a member, otherwise the team with the lowest id.
  const currentTeam =
    teams?.find((team) => team.id === activeTeamId) ?? teams?.[0] ?? null;

  const value = {
    currentTeam,
    teams: teams || [],
    isLoading: status === "pending",
    currentRole: currentTeam?.teamUsers[0]?.role ?? "MEMBER",
    currentIsAdmin: currentTeam?.teamUsers[0]?.role === "ADMIN",
    switchTeam,
  };

  return <TeamContext.Provider value={value}>{children}</TeamContext.Provider>;
}

export function useTeam() {
  const context = useContext(TeamContext);
  if (context === undefined) {
    throw new Error("useTeam must be used within a TeamProvider");
  }
  return context;
}
