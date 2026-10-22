import type { Config } from "../config.js";
import { CodemapsClient } from "./codemaps.js";
import { createHttp, type ApiCallLogger } from "./http.js";
import { MockNetworkMap } from "./mock.js";
import { DEMO_CTOS, demoGeocode } from "./mock-demo.js";
import { OltcloudClient } from "./oltcloud.js";
import { MockActivationService } from "./mock-activation.js";
import { MockCustomerActions } from "./mock-actions.js";
import { MockTicketService } from "./mock-tickets.js";
import { MockClientStatus } from "./mock-client-status.js";
import { MockContractService } from "./mock-contracts.js";
import type { ActivationService, ClientStatusService, ContractService, CustomerActions, Integrations, NetworkMap, TicketService } from "./types.js";
import { WikiNetworkMap } from "./wiki.js";
import { WikiActivationService } from "./wiki-activation.js";
import { WikiCustomerActions } from "./wiki-actions.js";
import { WikiTicketService } from "./wiki-tickets.js";
import { WikiClientStatus } from "./wiki-client-status.js";
import { WikiContractService } from "./wiki-contracts.js";

function createActivation(config: Config, log: ApiCallLogger): ActivationService | undefined {
  if (config.ACTIVATION_MODE === "off") return undefined;
  if (config.ACTIVATION_MODE === "mock") return new MockActivationService();
  const missing = (["WIKI_BASE_URL", "WIKI_WRITE_KEY"] as const).filter((k) => !config[k]);
  if (missing.length) throw new Error(`ACTIVATION_MODE=wiki sem: ${missing.join(", ")}`);
  return new WikiActivationService(createHttp("wiki", log), config.WIKI_BASE_URL!, config.WIKI_WRITE_KEY!);
}

function createActions(config: Config, log: ApiCallLogger): CustomerActions | undefined {
  if (config.AUTOMATION_MODE === "off") return undefined;
  if (config.AUTOMATION_MODE === "mock") return new MockCustomerActions();
  const missing = (["WIKI_BASE_URL", "WIKI_WRITE_KEY"] as const).filter((k) => !config[k]);
  if (missing.length) throw new Error(`AUTOMATION_MODE=wiki sem: ${missing.join(", ")}`);
  return new WikiCustomerActions(createHttp("wiki", log), config.WIKI_BASE_URL!, config.WIKI_WRITE_KEY!);
}

function createTickets(config: Config, log: ApiCallLogger): TicketService | undefined {
  if (config.AUTOMATION_MODE === "off") return undefined;
  if (config.AUTOMATION_MODE === "mock") return new MockTicketService();
  const missing = (["WIKI_BASE_URL", "WIKI_WRITE_KEY"] as const).filter((k) => !config[k]);
  if (missing.length) throw new Error(`AUTOMATION_MODE=wiki sem: ${missing.join(", ")}`);
  return new WikiTicketService(createHttp("wiki", log), config.WIKI_BASE_URL!, config.WIKI_WRITE_KEY!);
}

function createClientStatus(config: Config, log: ApiCallLogger): ClientStatusService | undefined {
  if (config.CLIENT_STATUS_MODE === "off") return undefined;
  if (config.CLIENT_STATUS_MODE === "mock") return new MockClientStatus();
  const missing = (["WIKI_BASE_URL", "WIKI_API_KEY"] as const).filter((k) => !config[k]);
  if (missing.length) throw new Error(`CLIENT_STATUS_MODE=wiki sem: ${missing.join(", ")}`);
  return new WikiClientStatus(createHttp("wiki", log), config.WIKI_BASE_URL!, config.WIKI_API_KEY!);
}

function createContracts(config: Config, log: ApiCallLogger): ContractService | undefined {
  if (config.CONTRACT_MODE === "off") return undefined;
  if (config.CONTRACT_MODE === "mock") return new MockContractService();
  const missing = (["WIKI_BASE_URL", "WIKI_WRITE_KEY"] as const).filter((k) => !config[k]);
  if (missing.length) throw new Error(`CONTRACT_MODE=wiki sem: ${missing.join(", ")}`);
  return new WikiContractService(createHttp("wiki", log), config.WIKI_BASE_URL!, config.WIKI_WRITE_KEY!);
}

export function createIntegrations(config: Config, log: ApiCallLogger): Integrations {
  const activation = createActivation(config, log);
  const actions = createActions(config, log);
  const { network } = createNetwork(config, log);
  return { network, activation, actions, tickets: createTickets(config, log), clientStatus: createClientStatus(config, log), contracts: createContracts(config, log) };
}

function createNetwork(config: Config, log: ApiCallLogger): { network: NetworkMap } {
  if (config.INTEGRATIONS_MODE === "mock") {
    return { network: config.MOCK_NETWORK === "demo" ? new MockNetworkMap(DEMO_CTOS, demoGeocode) : new MockNetworkMap() };
  }

  if (config.INTEGRATIONS_MODE === "wiki") {
    const missing = (["WIKI_BASE_URL", "WIKI_API_KEY"] as const).filter((k) => !config[k]);
    if (missing.length) throw new Error(`INTEGRATIONS_MODE=wiki sem: ${missing.join(", ")}`);
    return { network: new WikiNetworkMap(createHttp("wiki", log), config.WIKI_BASE_URL!, config.WIKI_API_KEY!) };
  }

  const required = ["CODEMAPS_TOKEN", "CODEMAPS_SECRET", "OLTCLOUD_USER", "OLTCLOUD_PASS"] as const;
  const missing = required.filter((k) => !config[k]);
  if (missing.length) throw new Error(`INTEGRATIONS_MODE=real sem: ${missing.join(", ")}`);

  const codemaps = new CodemapsClient(createHttp("codemaps", log), config.CODEMAPS_TOKEN!, config.CODEMAPS_SECRET!);
  const oltcloud = new OltcloudClient(
    createHttp("oltcloud", log),
    config.OLTCLOUD_BASE,
    config.OLTCLOUD_USER!,
    config.OLTCLOUD_PASS!,
  );
  const network: NetworkMap = {
    findNearbyCtos: (address, radiusM) => codemaps.findNearby(address, radiusM),
    getCtoVagas: (name) => oltcloud.getCtoVagas(name),
    health: async () => ({ ok: true, detail: "modo direto: sem verificação de saúde" }),
  };
  return { network };
}
