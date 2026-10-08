/**
 * An OpenAPI contract given as an entry point becomes searchable reference:
 * one chunk per operation, found like any reference page.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { fakeSite, type Grounded, removeStore, startGrounded } from "./harness";

const ORIGIN = "https://api-contract.test";

const contract = {
  openapi: "3.0.3",
  info: { title: "Pet Store", version: "2.1.0" },
  paths: {
    "/pets": {
      get: {
        operationId: "listPets",
        summary: "List every pet in the shelter",
        parameters: [
          {
            name: "limit",
            in: "query",
            description: "How many pets to return",
            schema: { type: "integer" },
          },
        ],
        responses: {
          "200": {
            description: "A page of pets",
            content: {
              "application/json": {
                schema: { type: "array", items: { $ref: "#/components/schemas/Pet" } },
              },
            },
          },
        },
      },
      post: {
        operationId: "adoptPet",
        summary: "Register an adoption request for a pet",
        requestBody: { $ref: "#/components/requestBodies/Adoption" },
        responses: { "201": { description: "Adoption recorded" } },
      },
    },
    "/pets/{petId}/vaccinations": {
      parameters: [{ $ref: "#/components/parameters/PetId" }],
      get: {
        operationId: "listVaccinations",
        summary: "Show the vaccination history of one pet",
        responses: { "200": { description: "Vaccinations" } },
      },
    },
  },
  components: {
    parameters: {
      PetId: { name: "petId", in: "path", required: true, schema: { type: "string" } },
    },
    requestBodies: {
      Adoption: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                adopterName: { type: "string" },
                pet: { $ref: "#/components/schemas/Pet" },
              },
            },
          },
        },
      },
    },
    schemas: {
      Pet: {
        type: "object",
        properties: {
          microchipNumber: { type: "string" },
          owner: { $ref: "#/components/schemas/Owner" },
        },
      },
      Owner: {
        type: "object",
        properties: {
          ownerPhone: { type: "string" },
          pets: { type: "array", items: { $ref: "#/components/schemas/Pet" } },
        },
      },
    },
  },
};

describe("OpenAPI entry points", () => {
  let grounded: Grounded | undefined;

  afterEach(async () => {
    await grounded?.stop();
    if (grounded) removeStore(grounded.storeDir);
    grounded = undefined;
    vi.unstubAllEnvs();
  });

  const collect = async (path: string, body: string, type: string) => {
    fakeSite(ORIGIN, { [path]: { body, type } });
    grounded = await startGrounded();
    await grounded.scrape({ url: `${ORIGIN}${path}`, library: "petstore" });
    return grounded;
  };

  const expectOperationsSearchable = async (g: Grounded) => {
    const vaccinations = await g.call("search_docs", {
      library: "petstore",
      query: "vaccination history",
    });
    const first = vaccinations.split("Result 2:")[0];
    expect(first).toContain("GET /pets/{petId}/vaccinations");
    expect(first).toContain("petId");
    expect(first).not.toContain("POST /pets");

    const adoption = await g.call("search_docs", {
      library: "petstore",
      query: "adoption request",
    });
    const top = adoption.split("Result 2:")[0];
    expect(top).toContain("POST /pets");
    // $ref schemas are resolved into the operation, cycles cut short.
    expect(top).toContain("adopterName");
    expect(top).toContain("microchipNumber");
    expect(top).toContain("ownerPhone");
  };

  it("indexes one searchable chunk per operation of a JSON contract", async () => {
    const g = await collect("/openapi.json", JSON.stringify(contract), "application/json");
    await expectOperationsSearchable(g);
    const status = await g.call("list_libraries");
    expect(status).toContain("1 pages collected");
    const grep = await g.call("grep_docs", { library: "petstore", pattern: "/^## [A-Z]+ /" });
    expect(grep.split("\n").filter((l) => l.startsWith(ORIGIN))).toHaveLength(3);
  });

  it("reads a YAML contract the same way, even served as plain text", async () => {
    const g = await collect("/contracts/pets.yaml", YAML.stringify(contract), "text/plain");
    await expectOperationsSearchable(g);
  });

  it("handles a JSON file that is not OpenAPI as before", async () => {
    const g = await collect(
      "/data.json",
      JSON.stringify({ name: "settings", paths: { a: 1 }, flavour: "vanilla" }),
      "application/json",
    );
    const result = await g.call("search_docs", { library: "petstore", query: "vanilla" });
    expect(result).toContain("vanilla");
    expect(result).not.toContain("## GET");
  });
});
