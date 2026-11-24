/**
 * Human-readable hardware warnings for the first-run model step.
 * These are conservative capability diagnostics, NOT evidence a particular
 * model will fit available VRAM/RAM or follow tool-call instructions.
 */
export interface FirstRunHardwareProfile {
  os: string;
  arch: string;
  availableRamBytes: number;
  supportedRuntimes: readonly string[];
  metalAvailable: boolean;
}
export function firstRunHardwareWarnings(hardware: FirstRunHardwareProfile): string[] {
  const warnings: string[] = [];
  if (hardware.supportedRuntimes.length === 0) {
    warnings.push("No supported local model runtime was detected. Configure a cloud provider or inspect Runtime Hub → Overview before downloading weights.");
  }
  if (hardware.os !== "macos" || hardware.arch !== "aarch64" || !hardware.metalAvailable) {
    warnings.push("MLX requires Apple Silicon with a working Metal driver. Choose a supported llama.cpp/Ollama runtime or a configured cloud provider.");
  }
  if (hardware.availableRamBytes < 4 * 1024 ** 3) {
    warnings.push("Less than 4 GiB system RAM is available; larger local models may fail to load. Use a smaller model or a cloud provider.");
  }
  return warnings;
}
