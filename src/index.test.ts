import { expect, it } from "vitest";
import { UAI_KERNEL_VERSION } from "./index.ts";

it("exposes the kernel version", () => {
  expect(UAI_KERNEL_VERSION).toBe("0.1.0");
});
