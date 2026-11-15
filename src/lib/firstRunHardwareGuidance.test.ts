import { describe, expect, it } from "vitest";
import { firstRunHardwareWarnings } from "./firstRunHardwareGuidance";

const apple = {
  os: "macos", arch: "aarch64", availableRamBytes: 16 * 1024 ** 3,
  supportedRuntimes: ["mlx", "llama_cpp"], metalAvailable: true,
};
describe("first-run model hardware guidance", () => {
  it("does not warn about Apple Silicon Metal when supported and memory available", () => {
    expect(firstRunHardwareWarnings(apple)).toEqual([]);
  });
  it("shows explicit MLX warning on Windows and Linux, not generic success", () => {
    for (const os of ["windows", "linux"]) {
      expect(firstRunHardwareWarnings({ ...apple, os })).toEqual(
        expect.arrayContaining([expect.stringContaining("MLX requires Apple Silicon")]),
      );
    }
  });
  it("does not mistake Intel macOS or Apple Silicon without Metal for MLX-capable", () => {
    expect(firstRunHardwareWarnings({ ...apple, arch: "x86_64" }).join(" ")).toContain("MLX requires Apple Silicon");
    expect(firstRunHardwareWarnings({ ...apple, metalAvailable: false }).join(" ")).toContain("MLX requires Apple Silicon");
  });
  it("flags unsupported local runtimes and objectively low free RAM", () => {
    const warnings = firstRunHardwareWarnings({ ...apple, supportedRuntimes: [], availableRamBytes: 1 * 1024 ** 3 });
    expect(warnings).toHaveLength(2);
    expect(warnings.join(" ")).toContain("No supported local model runtime");
    expect(warnings.join(" ")).toContain("Less than 4 GiB");
  });
});
