export type BitbucketPRState = "OPEN" | "MERGED" | "DECLINED";

export interface BitbucketRef {
  id: string;
}

export interface BitbucketUser {
  name: string;
  emailAddress?: string;
  displayName?: string;
}

export interface BitbucketPullRequest {
  id: number;
  title: string;
  description?: string;
  state: BitbucketPRState;
  fromRef: BitbucketRef;
  toRef: BitbucketRef;
  author?: {
    user: BitbucketUser;
  };
}

export interface BitbucketPullRequestList {
  size: number;
  start: number;
  isLastPage: boolean;
  values: BitbucketPullRequest[];
}

export interface BitbucketCreatePRInput {
  title: string;
  description?: string;
  source_branch: string;
  target_branch: string;
  reviewers?: string[];
}

export interface BitbucketComment {
  id: number;
  text: string;
  author?: BitbucketUser;
}

export interface BitbucketErrorResponse {
  errors?: { message: string }[];
}
