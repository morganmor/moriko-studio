
let clientModuleVersion = 0;

export function bumpAddonClientVersion(): void {
  clientModuleVersion++;
}

export function addonClientVersion(): number {
  return clientModuleVersion;
}
