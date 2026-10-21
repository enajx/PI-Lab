import { expect, test } from "vitest"
import { validateLocaleSource } from "./validate-locales"

test("flat locale validation rejects conflicting duplicate keys, including escaped spellings", () => {
  expect(() => validateLocaleSource('{"Save":"Guardar","S\\u0061ve":"Salvar"}', "es.json")).toThrow(
    /es.json.*Save.*Guardar.*Salvar/,
  )
  expect(() => validateLocaleSource('{"Save":"Guardar","Save":"Guardar"}', "es.json")).toThrow(
    /duplicate/i,
  )
})

test("locale validation accepts escaped string values and rejects nested tables", () => {
  expect(() =>
    validateLocaleSource('{"Save":"Guardar \\"ahora\\"","Cancel":"Cancelar"}', "es.json"),
  ).not.toThrow()
  expect(() => validateLocaleSource('{"Save":{"es":"Guardar"}}', "es.json")).toThrow(/flat string/)
})
