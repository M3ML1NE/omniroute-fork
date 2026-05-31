export interface JiraIssue {
  id: string;
  key: string;
  self?: string;
  fields: {
    summary?: string;
    description?: string;
    status?: { name: string; id: string };
    issuetype?: { name: string };
    [key: string]: unknown;
  };
}

export interface JiraSearchResult {
  startAt: number;
  maxResults: number;
  total: number;
  issues: JiraIssue[];
}

export interface JiraCreateIssueInput {
  project_key: string;
  issue_type: string;
  summary: string;
  description?: string;
  fields?: Record<string, unknown>;
}

export interface JiraComment {
  id: string;
  body: string;
  author?: { name: string };
  created?: string;
}

export interface JiraErrorResponse {
  errorMessages?: string[];
  errors?: Record<string, string>;
}
