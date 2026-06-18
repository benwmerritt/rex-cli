import { describe, expect, it } from "bun:test";
import {
  createStocktakeEnvelope,
  DEFAULT_WMS_TIMEOUT_MS,
  parseCreateStocktakeResponse,
  WmsClient,
  type WmsConfig,
} from "../../src/core/wms";
import { ApiError } from "../../src/core/errors";
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

  it("trims whitespace around the CreateStocktake Result value", () => {
    const res = parseCreateStocktakeResponse(`<soap:Envelope><soap:Body>
      <CreateStocktakeResponse xmlns="http://retailexpress.com.au/">
        <CreateStocktakeResult>&lt;Response&gt;&lt;Result&gt; Success &lt;/Result&gt;&lt;Message /&gt;&lt;/Response&gt;</CreateStocktakeResult>
      </CreateStocktakeResponse>
    </soap:Body></soap:Envelope>`);
    expect(res).toEqual({ ok: true, result: "Success" });
  });

  it("parses double-encoded XML entities returned by CreateStocktake", () => {
    const res = parseCreateStocktakeResponse(`<soap:Envelope><soap:Body>
      <CreateStocktakeResponse xmlns="http://retailexpress.com.au/">
        <CreateStocktakeResult>&amp;lt;Response&amp;gt;&amp;lt;Result&amp;gt;Success&amp;lt;/Result&amp;gt;&amp;lt;Message&amp;gt;Created &amp;amp;amp; checked&amp;lt;/Message&amp;gt;&amp;lt;/Response&amp;gt;</CreateStocktakeResult>
      </CreateStocktakeResponse>
    </soap:Body></soap:Envelope>`);
    expect(res).toEqual({ ok: true, result: "Success", message: "Created & checked" });
  });

  it("reports a non-success CreateStocktake result as an API error", () => {
    try {
      parseCreateStocktakeResponse(
        `<soap:Envelope><soap:Body>
          <CreateStocktakeResponse xmlns="http://retailexpress.com.au/">
            <CreateStocktakeResult>&lt;Response&gt;&lt;Result&gt;Error&lt;/Result&gt;&lt;Message&gt;Bad stocktake&lt;/Message&gt;&lt;/Response&gt;</CreateStocktakeResult>
          </CreateStocktakeResponse>
        </soap:Body></soap:Envelope>`,
        202,
      );
      throw new Error("Expected parseCreateStocktakeResponse to throw.");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(202);
      expect((err as ApiError).message).toBe("Retail Express WMS stocktake failed: Bad stocktake");
      expect((err as ApiError).details).toEqual({ result: "Error", message: "Bad stocktake" });
    }
  });

  it("reports a missing inner Result element as an API error", () => {
    expect(() =>
      parseCreateStocktakeResponse(`<soap:Envelope><soap:Body>
        <CreateStocktakeResponse xmlns="http://retailexpress.com.au/">
          <CreateStocktakeResult>&lt;Response&gt;&lt;Message&gt;No result&lt;/Message&gt;&lt;/Response&gt;</CreateStocktakeResult>
        </CreateStocktakeResponse>
      </soap:Body></soap:Envelope>`),
    ).toThrow("Retail Express WMS stocktake failed: No result");
  });

  it("reports malformed XML without a CreateStocktakeResult as an API error", () => {
    try {
      parseCreateStocktakeResponse("<soap:Envelope><soap:Body><not-xml", 200);
      throw new Error("Expected parseCreateStocktakeResponse to throw.");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).message).toBe("Retail Express WMS response did not include CreateStocktakeResult.");
      expect((err as ApiError).details).toEqual({ body: "<soap:Envelope><soap:Body><not-xml" });
    }
  });

  it("reports SOAP faults as API errors with fault details", () => {
    try {
      parseCreateStocktakeResponse(
        `<soap:Envelope><soap:Body>
          <soap:Fault>
            <faultcode>soap:Server</faultcode>
            <faultstring>Stocktake service failed &amp; needs review</faultstring>
          </soap:Fault>
        </soap:Body></soap:Envelope>`,
        500,
      );
      throw new Error("Expected parseCreateStocktakeResponse to throw.");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(500);
      expect((err as ApiError).message).toBe("Retail Express WMS SOAP fault: Stocktake service failed & needs review");
      expect((err as ApiError).details).toEqual({ fault: "Stocktake service failed & needs review" });
    }
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

  it("reports non-OK CreateStocktake HTTP responses with truncated response details", async () => {
    const responseBody = `WMS failure: ${"x".repeat(1100)}`;
    const transport: Transport = async () => new Response(responseBody, { status: 500 });
    const client = new WmsClient({ config, transport });

    try {
      await client.createStocktake({ outletId: 3, userId: 4, items: [{ productId: 1, variance: 1 }] });
      throw new Error("Expected createStocktake to throw.");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(500);
      expect((err as ApiError).message).toBe("Retail Express WMS returned HTTP 500.");
      expect((err as ApiError).details).toEqual({ body: responseBody.slice(0, 1000) });
    }
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

  it("uses the default 30 second timeout when creating the request signal", async () => {
    const timeoutController = new AbortController();
    let seenTimeout = 0;
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
      timeoutSignalFactory: (ms) => {
        seenTimeout = ms;
        return timeoutController.signal;
      },
    });

    await client.createStocktake({ outletId: 3, userId: 4, items: [{ productId: 1, variance: 1 }] });
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
