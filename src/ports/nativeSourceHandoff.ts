/**
 * Host-owned native-source handoff, already scoped to one authenticated Backpack.
 *
 * The source reference is deliberately opaque here. Grant lookup, expiry and native
 * execution stay below this port; callers cannot supply a machine locator.
 */
declare const authenticatedBackpackRefBrand: unique symbol;
declare const grantedSourceRefBrand: unique symbol;

export type AuthenticatedBackpackRef = string & {
  readonly [authenticatedBackpackRefBrand]: true;
};

export type GrantedSourceRef = string & {
  readonly [grantedSourceRefBrand]: true;
};

export interface NativeSourceHandoffCapability {
  readonly backpack: AuthenticatedBackpackRef;
  open(source: GrantedSourceRef): Promise<void>;
  reveal(source: GrantedSourceRef): Promise<void>;
}
