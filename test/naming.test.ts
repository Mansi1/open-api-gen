import { expect, test } from "bun:test";
import { camel, camelProperty, kebab, pascal } from "../src/intermediate-format/naming.ts";

test.each([
  ["get-systems", "GetSystems", "getSystems", "get-systems"],
  ["Issue custom field values (apps)", "IssueCustomFieldValuesApps", "issueCustomFieldValuesApps", "issue-custom-field-values-apps"],
  ["shipping-offer", "ShippingOffer", "shippingOffer", "shipping-offer"],
  ["getMyShip", "GetMyShip", "getMyShip", "getmyship"],
  ["2fa", "_2fa", "_2fa", "2fa"],
  ["", "_", "_", "_"],
])("%p → pascal %p, camel %p, kebab %p", (input, expectedPascal, expectedCamel, expectedKebab) => {
  expect(pascal(input)).toBe(expectedPascal);
  expect(camel(input)).toBe(expectedCamel);
  expect(kebab(input)).toBe(expectedKebab);
});

test.each([
  ["first_name", "firstName"],
  ["last_login_at", "lastLoginAt"],
  ["userId", "userId"],
  ["_id", "_id"],
  ["$ref", "$ref"],
  ["X-Rate-Limit", "xRateLimit"],
  ["__", "__"],
  // Names that are not words and separators keep their spelling (GitHub reactions have "+1" and "-1").
  ["+1", "+1"],
  ["-1", "-1"],
  ["16x16", "16x16"],
  ["a+b", "a+b"],
  ["user.name", "userName"],
])("camelProperty(%p) = %p", (input, expected) => {
  expect(camelProperty(input)).toBe(expected);
});
