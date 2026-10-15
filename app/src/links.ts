import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

export interface Link {
  slug: string;
  target: string;
  createdAt: string;
}

export interface LinkStore {
  /** Returns false when the slug is already taken. Never overwrites. */
  create(link: Link): Promise<boolean>;
  get(slug: string): Promise<Link | undefined>;
}

export class DynamoLinkStore implements LinkStore {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async create(link: Link): Promise<boolean> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: link,
          // Two requests racing for one slug: exactly one wins, the other gets a 409.
          ConditionExpression: 'attribute_not_exists(slug)',
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  }

  async get(slug: string): Promise<Link | undefined> {
    const res = await this.doc.send(new GetCommand({ TableName: this.tableName, Key: { slug } }));
    return res.Item as Link | undefined;
  }
}
