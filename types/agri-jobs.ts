export interface JobListing {
  duplicate_key: string;
  source: string;
  source_site: string;
  source_url: string;
  title: string;
  company: string;
  location: string;
  employment_status: string;
  salary_min: number;
  has_dormitory: boolean;
  welcome_inexperienced: boolean;
  rule_score: number;
  ai_score: number;
  final_score: number;
  judgment: string;
  judgment_reason: string;
  first_seen_at: string;
  last_seen_at: string;
  fetched_at: string;
  is_new: boolean;
  ai_summary?: string;
}

export interface JobStats {
  total: number;
  passed: number;
  held: number;
  excluded: number;
  new_jobs: number;
}

export interface SourceSummary {
  source: string;
  count: number;
  error: number;
}
