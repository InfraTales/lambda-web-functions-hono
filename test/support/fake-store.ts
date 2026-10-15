import type { Link, LinkStore } from '../../app/src/links';

/** Same rule as the DynamoDB condition: create never overwrites. Optional delay to mix up timing. */
export class FakeStore implements LinkStore {
  links = new Map<string, Link>();
  constructor(private readonly maxDelayMs = 0) {}

  private async pause(): Promise<void> {
    if (this.maxDelayMs) await new Promise((r) => setTimeout(r, Math.random() * this.maxDelayMs));
  }

  async create(link: Link): Promise<boolean> {
    await this.pause();
    if (this.links.has(link.slug)) return false;
    this.links.set(link.slug, link);
    return true;
  }

  async get(slug: string): Promise<Link | undefined> {
    await this.pause();
    return this.links.get(slug);
  }
}
