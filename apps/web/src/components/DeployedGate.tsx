"use client";

import type { ReactNode } from "react";
import { appDeployment, isDeployed } from "@/lib/config";
import { useAppNetwork } from "@/lib/wallet/appNetwork";
import { NotDeployed } from "./states";

/**
 * Shows `children` when the active network has its contracts deployed, else the not-deployed state.
 * Decided in the browser, so it follows a network switch; the server renders the build's network.
 */
export function DeployedGate({ willShow, children }: { willShow?: string[]; children: ReactNode }) {
  useAppNetwork();
  return isDeployed(appDeployment) ? children : <NotDeployed willShow={willShow} />;
}
