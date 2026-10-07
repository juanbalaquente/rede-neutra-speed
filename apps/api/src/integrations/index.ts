import type { Config } from "../config.js";
import { CodemapsClient } from "./codemaps.js";
import { createHttp, type ApiCallLogger } from "./http.js";
import { MockNetworkMap } from "./mock.js";
import { OltcloudClient } from "./oltcloud.js";
import type { Integrations, NetworkMap } from "./types.js";
import { WikiNetworkMap } from "./wiki.js";

export function createIntegrations(config: Config, log: ApiCallLogger): Integrations {
  if (config.INTEGRATIONS_MODE === "mock") return { network: new MockNetworkMap() };

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
