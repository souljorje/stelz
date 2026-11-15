// Camofox creates, registers, and closes its own pages. A person or a website can open
// other pages in the same headed browser. The orphan page reaper must leave those pages open.
const owned = new WeakSet<object>();

export function ownPage<Page extends object | null | undefined>(page: Page): Page {
  if (page) owned.add(page);
  return page;
}

// An orphan is a page that Camofox owned and no longer tracks or leases.
export function isOrphanPage(page: object, registered: ReadonlySet<object>, leased: boolean) {
  return owned.has(page) && !registered.has(page) && !leased;
}
