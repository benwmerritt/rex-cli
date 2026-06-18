import { describe, expect, it } from "bun:test";
import {
  createStocktakeEnvelope,
  DEFAULT_WMS_TIMEOUT_MS,
  parseCreateStocktakeResponse,
  WmsClient,
  type WmsConfig,
} from "../../src/core/wms";
import type { Transport } from "../../src/core/transport";

const config: WmsConfig = {
  clientId: "client&1",
  username: "wsi",
  password: "p<ass",
  url: "https://example.test/service.asmx?wsdl",
};

describe("WMS stocktake SOAP", () => {
  it("builds a CreateStocktake envelope with escaped credentials and item variances", () => {
    const xml = createStocktakeEnvelope(config, {
      outletId: 3,
      userId: 4,
      items: [
        { productId: 124001, variance: -2 },
        { productId: 124005, variance: 5 },
      ],
    });
    expect(xml).toContain("<ret:ClientID>client&amp;1</ret:ClientID>");
    expect(xml).toContain("<ret:Password>p&lt;ass</ret:Password>");
    expect(xml).toContain("<ret:Item>124001</ret:Item><ret:Value>-2</ret:Value>");
    expect(xml).toContain("<ret:whid>3</ret:whid>");
    expect(xml).toContain("<ret:userId>4</ret:userId>");
  });

  it("parses the encoded success payload returned by CreateStocktake", () => {
    const res = parseCreateStocktakeResponse(`<soap:Envelope><soap:Body>
      <CreateStocktakeResponse xmlns="http://retailexpress.com.au/">
        <CreateStocktakeResult>&lt;Response&gt;&lt;Result&gt;Success&lt;/Result&gt;&lt;Message /&gt;&lt;/Response&gt;</CreateStocktakeResult>
      </CreateStocktakeResponse>
    </soap:Body></soap:Envelope>`);
    expect(res).toEqual({ ok: true, result: "Success" });
  });

  it("posts to the .asmx URL rather than the WSDL URL", async () => {
    let seenUrl = "";
    let seenAction = "";
    let seenSignal: AbortSignal | undefined;
    const transport: Transport = async (url, init) => {
      seenUrl = url;
      seenAction = String(init.headers && (init.headers as Record<string, string>).SOAPAction);
      seenSignal = init.signal ?? undefined;
      return new Response(
        `<soap:Envelope><soap:Body><CreateStocktakeResponse><CreateStocktakeResult>&lt;Response&gt;&lt;Result&gt;Success&lt;/Result&gt;&lt;Message /&gt;&lt;/Response&gt;</CreateStocktakeResult></CreateStocktakeResponse></soap:Body></soap:Envelope>`,
      );
    };
    const client = new WmsClient({ config, transport });
    await client.createStocktake({ outletId: 3, userId: 4, items: [{ productId: 1, variance: 1 }] });
    expect(seenUrl).toBe("https://example.test/service.asmx");
    expect(seenAction).toBe('"http://retailexpress.com.au/CreateStocktake"');
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal?.aborted).toBe(false);
  });

  it("times out CreateStocktake requests with an injectable scheduler", async () => {
    let cleared = false;
    const transport: Transport = async (_url, init) => {
      expect((init.signal as AbortSignal | undefined)?.aborted).toBe(true);
      throw new Error("aborted");
    };
    const client = new WmsClient({
      config,
      transport,
      timeoutMs: 25,
      timeoutScheduler: {
        setTimeout: (callback, ms) => {
          expect(ms).toBe(25);
          callback();
          return "timer";
        },
        clearTimeout: (timer) => {
          expect(timer).toBe("timer");
          cleared = true;
        },
      },
    });

    await expect(client.createStocktake({ outletId: 3, userId: 4, items: [{ productId: 1, variance: 1 }] })).rejects.toThrow(
      "Retail Express WMS request timed out after 25ms.",
    );
    expect(cleared).toBe(true);
  });

  it("uses AbortSignal.timeout with a 30 second timeout by default", async () => {
    const originalTimeout = AbortSignal.timeout;
    const timeoutController = new AbortController();
    let seenTimeout = 0;
    let seenSignal: AbortSignal | undefined;
    AbortSignal.timeout = ((ms: number) => {
      seenTimeout = ms;
      return timeoutController.signal;
    }) as typeof AbortSignal.timeout;
    const transport: Transport = async (_url, init) => {
      seenSignal = init.signal ?? undefined;
      return new Response(
        `<soap:Envelope><soap:Body><CreateStocktakeResponse><CreateStocktakeResult>&lt;Response&gt;&lt;Result&gt;Success&lt;/Result&gt;&lt;Message /&gt;&lt;/Response&gt;</CreateStocktakeResult></CreateStocktakeResponse></soap:Body></soap:Envelope>`,
      );
    };
    const client = new WmsClient({ config, transport });

    try {
      await client.createStocktake({ outletId: 3, userId: 4, items: [{ productId: 1, variance: 1 }] });
    } finally {
      AbortSignal.timeout = originalTimeout;
    }
    expect(seenTimeout).toBe(DEFAULT_WMS_TIMEOUT_MS);
    expect(seenSignal).toBe(timeoutController.signal);
  });

  it("combines a parent abort signal with the timeout signal", async () => {
    const parentController = new AbortController();
    const timeoutController = new AbortController();
    parentController.abort(new Error("cancelled"));
    let seenSignal: AbortSignal | undefined;
    const transport: Transport = async (_url, init) => {
      seenSignal = init.signal ?? undefined;
      return new Response(
        `<soap:Envelope><soap:Body><CreateStocktakeResponse><CreateStocktakeResult>&lt;Response&gt;&lt;Result&gt;Success&lt;/Result&gt;&lt;Message /&gt;&lt;/Response&gt;</CreateStocktakeResult></CreateStocktakeResponse></soap:Body></soap:Envelope>`,
      );
    };
    const client = new WmsClient({
      config,
      transport,
      signal: parentController.signal,
      timeoutSignalFactory: () => timeoutController.signal,
    });

    await client.createStocktake({ outletId: 3, userId: 4, items: [{ productId: 1, variance: 1 }] });
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal?.aborted).toBe(true);
  });

  it("uses the injected scheduler when provided", async () => {
    let seenTimeout = 0;
    const transport: Transport = async () =>
      new Response(
        `<soap:Envelope><soap:Body><CreateStocktakeResponse><CreateStocktakeResult>&lt;Response&gt;&lt;Result&gt;Success&lt;/Result&gt;&lt;Message /&gt;&lt;/Response&gt;</CreateStocktakeResult></CreateStocktakeResponse></soap:Body></soap:Envelope>`,
      );
    const client = new WmsClient({
      config,
      transport,
      timeoutScheduler: {
        setTimeout: (_callback, ms) => {
          seenTimeout = ms;
          return "timer";
        },
        clearTimeout: () => {},
      },
    });

    await client.createStocktake({ outletId: 3, userId: 4, items: [{ productId: 1, variance: 1 }] });
    expect(seenTimeout).toBe(DEFAULT_WMS_TIMEOUT_MS);
  });
});
