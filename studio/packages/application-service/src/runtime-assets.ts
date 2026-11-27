/** Set by the generated standalone entry, before any service is created. */
let packagedAssets: Readonly<Record<string, string>> | undefined;
export function configurePackagedAssets(
  assets: Readonly<Record<string, string>>,
): void {
  packagedAssets = Object.freeze({ ...assets });
}
export function packagedStaticAssets():
  | Readonly<Record<string, string>>
  | undefined {
  return packagedAssets;
}
