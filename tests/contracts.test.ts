import { describe, expect, it } from "vitest";
import { Endpoint } from "../src/constants";
import spec from "../docs/novelai-openapi.json";

describe("official API contract", () => {
  const paths = new Set(Object.keys(spec.paths));

  it("contains exactly the 13 generation-domain paths", () => {
    expect(paths.size).toBe(13);
  });

  it("every implemented endpoint exists in the official snapshot", () => {
    for (const path of Object.values(Endpoint)) {
      expect(paths.has(path), `missing Endpoint path: ${path}`).toBe(true);
    }
  });

  it("has no duplicate endpoint paths", () => {
    const values = Object.values(Endpoint);
    expect(new Set(values).size).toBe(values.length);
  });
});
