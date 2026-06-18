import { describe, expect, it } from "bun:test";
import {
  createStocktakeEnvelope,
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
    const transport: Transport = async (url, init) => {
      seenUrl = url;
      seenAction = String(init.headers && (init.headers as Record<string, string>).SOAPAction);
      return new Response(
        `<soap:Envelope><soap:Body><CreateStocktakeResponse><CreateStocktakeResult>&lt;Response&gt;&lt;Result&gt;Success&lt;/Result&gt;&lt;Message /&gt;&lt;/Response&gt;</CreateStocktakeResult></CreateStocktakeResponse></soap:Body></soap:Envelope>`,
      );
    };
    const client = new WmsClient({ config, transport });
    await client.createStocktake({ outletId: 3, userId: 4, items: [{ productId: 1, variance: 1 }] });
    expect(seenUrl).toBe("https://example.test/service.asmx");
    expect(seenAction).toBe('"http://retailexpress.com.au/CreateStocktake"');
  });
});
