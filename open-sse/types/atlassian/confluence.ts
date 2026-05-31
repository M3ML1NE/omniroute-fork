export interface ConfluenceSpace {
  key: string;
  name?: string;
}

export interface ConfluenceVersion {
  number: number;
  when?: string;
}

export interface ConfluenceBody {
  storage: {
    value: string;
    representation: "storage";
  };
}

export interface ConfluencePage {
  id: string;
  type: "page" | "blogpost";
  title: string;
  space?: ConfluenceSpace;
  version?: ConfluenceVersion;
  body?: ConfluenceBody;
  ancestors?: Array<{ id: string }>;
}

export interface ConfluenceSearchResult {
  results: ConfluencePage[];
  size: number;
  totalSize?: number;
  limit: number;
  start?: number;
}

export interface ConfluenceCreatePageInput {
  space_key: string;
  title: string;
  body: string;
  parent_id?: string;
}

export interface ConfluenceUpdatePageInput {
  title: string;
  body: string;
  /** If undefined, client fetches current version and increments. */
  version_number?: number;
}
