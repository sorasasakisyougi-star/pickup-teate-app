"use client";

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { JobListing, JobStats, SourceSummary } from '@/types/agri-jobs';

export default function AgriJobsDashboard() {
  const [jobs, setJobs] = useState<JobListing[]>([]);
  const [stats, setStats] = useState<JobStats | null>(null);
  const [sourceSummary, setSourceSummary] = useState<SourceSummary[]>([]);
  
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isImporting, setIsImporting] = useState(false);

  // Filters
  const [keyword, setKeyword] = useState('');
  const [source, setSource] = useState('all');
  const [judgment, setJudgment] = useState('all');
  const [hasDormitory, setHasDormitory] = useState(false);
  const [welcomeInexperienced, setWelcomeInexperienced] = useState(false);
  const [isNew, setIsNew] = useState(false);

  const [importErrors, setImportErrors] = useState<string[]>([]);

  const fetchDashboardData = async () => {
    setIsLoading(true);
    setError(null);
    try {
      // 1. Fetch Stats
      const statsRes = await fetch('/api/jobs/stats');
      if (statsRes.ok) {
        const statsData = await statsRes.json();
        setStats(statsData);
      }

      // 2. Fetch Source Summary
      const summaryRes = await fetch('/api/source-summary');
      if (summaryRes.ok) {
        const summaryData = await summaryRes.json();
        setSourceSummary(summaryData.sources);
      }

      // 3. Fetch Jobs
      const params = new URLSearchParams({
        keyword,
        source,
        judgment,
        has_dormitory: hasDormitory.toString(),
        welcome_inexperienced: welcomeInexperienced.toString(),
        is_new: isNew.toString()
      });

      const jobsRes = await fetch(`/api/jobs?${params.toString()}`);
      if (!jobsRes.ok) throw new Error('求人データの取得に失敗しました');
      const jobsData = await jobsRes.json();
      setJobs(jobsData.jobs);

    } catch (err: any) {
      setError(err.message || 'データ取得エラー');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSeedData = async () => {
    try {
      setIsImporting(true);
      const res = await fetch('/api/jobs/seed', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        alert(`成功: ${data.message} (${data.count}件)`);
        await fetchDashboardData();
      } else {
        alert(`エラー: ${data.error}`);
      }
    } catch (err: any) {
      alert(`通信エラー: ${err.message}`);
    } finally {
      setIsImporting(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      setIsImporting(true);
      const text = await file.text();
      const res = await fetch('/api/jobs/import', {
        method: 'POST',
        headers: {
          'Content-Type': 'text/csv',
        },
        body: text,
      });
      const data = await res.json();
      
      if (res.ok) {
        let msg = `インポート完了: ${data.total}件中 ${data.success_count}件成功`;
        if (data.skipped_count > 0) {
          msg += ` (スキップ: ${data.skipped_count}件)`;
          setImportErrors(data.reasons || []);
        } else {
          setImportErrors([]);
        }
        alert(msg);
        await fetchDashboardData();
      } else {
        alert(`エラー: ${data.error}`);
        setImportErrors([data.error]);
      }
    } catch (err: any) {
      alert(`通信エラー: ${err.message}`);
      setImportErrors([err.message]);
    } finally {
      setIsImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };


  useEffect(() => {
    fetchDashboardData();
  }, [keyword, source, judgment, hasDormitory, welcomeInexperienced, isNew]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans p-6">
      <div className="max-w-7xl mx-auto space-y-8">
        
        {/* Header */}
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-extrabold tracking-tight text-emerald-800">農業求人ダッシュボード</h1>
            <p className="text-sm text-slate-500 mt-1">実データ監視と求人分析ポータル</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link 
              href="/agri-jobs/add"
              className="px-4 py-2 bg-slate-800 hover:bg-slate-900 text-white rounded-lg shadow-sm transition-colors text-sm font-medium flex items-center gap-1.5"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
              求人手動登録
            </Link>
            <button 
              onClick={() => fileInputRef.current?.click()}
              disabled={isImporting}
              className="px-4 py-2 bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 rounded-lg shadow-sm transition-colors text-sm font-medium flex items-center gap-1.5 disabled:opacity-50"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
              {isImporting ? "処理中..." : "CSVインポート"}
            </button>
            <input 
              type="file" 
              ref={fileInputRef} 
              onChange={handleFileUpload} 
              accept=".csv" 
              className="hidden" 
            />
            <button 
              onClick={fetchDashboardData}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg shadow-sm transition-colors text-sm font-medium ml-auto md:ml-2"
            >
              更新
            </button>
          </div>
        </header>

        {/* CSV Guide (collapsible/info) */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-800 flex items-start gap-3">
          <svg className="w-5 h-5 text-blue-500 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
          <div className="w-full">
            <p className="font-bold mb-1">CSVインポートの仕様</p>
            <p className="mb-1 text-blue-700"><strong>必須列:</strong> title, company_name, location</p>
            <p className="mb-1 text-blue-700"><strong>任意列:</strong> salary, source_site, source_url, judgment, final_score, rule_score, ai_score, summary, fetched_at, has_dormitory (1/0), welcome_inexperienced (1/0)</p>
            <p className="text-xs opacity-80 mt-2">※ 1行目は列名（ヘッダー）を記載してください。形式エラーの行はスキップされ警告が表示されます。</p>
            
            <div className="mt-3 flex gap-4 pt-3 border-t border-blue-200/60">
              <a href="/api/csv/template" download="template.csv" className="text-blue-600 hover:text-blue-800 underline text-sm font-medium flex items-center gap-1">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>空のテンプレートをDL
              </a>
              <a href="/api/csv/sample" download="sample_real_jobs.csv" className="text-blue-600 hover:text-blue-800 underline text-sm font-medium flex items-center gap-1">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>記入例付きサンプルをDL
              </a>
            </div>
          </div>
        </div>

        {importErrors.length > 0 && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-800 flex items-start gap-3">
             <svg className="w-5 h-5 text-red-500 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
             <div className="w-full">
               <p className="font-bold mb-1">CSVインポートエラー詳細 ({importErrors.length}件)</p>
               <ul className="list-disc list-inside space-y-1">
                 {importErrors.map((err, i) => (
                   <li key={i} className="text-red-700">{err}</li>
                 ))}
               </ul>
             </div>
          </div>
        )}

        {/* KPI Cards */}
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <StatCard title="総件数" value={stats.total} color="bg-blue-50 text-blue-700 border-blue-200" />
            <StatCard title="通過" value={stats.passed} color="bg-emerald-50 text-emerald-700 border-emerald-200" />
            <StatCard title="保留" value={stats.held} color="bg-amber-50 text-amber-700 border-amber-200" />
            <StatCard title="除外" value={stats.excluded} color="bg-gray-50 text-gray-700 border-gray-200" />
            <StatCard title="今日の新着" value={stats.new_jobs} color="bg-purple-50 text-purple-700 border-purple-200" highlight />
          </div>
        )}

        {/* Source Summary */}
        <section className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
          <h2 className="text-lg font-semibold mb-4 text-slate-800">サイト別取得サマリー (最新)</h2>
          <div className="flex flex-wrap gap-4">
            {sourceSummary.map((s, idx) => (
              <div key={idx} className="flex flex-col bg-slate-50 border border-slate-100 rounded-lg p-3 min-w-[120px]">
                <span className="text-xs font-medium text-slate-500">{s.source}</span>
                <span className="text-lg font-bold text-slate-800">{s.count} <span className="text-xs font-normal text-slate-400">件</span></span>
                {s.error > 0 && <span className="text-xs text-red-500 font-medium mt-1">エラー: {s.error}</span>}
              </div>
            ))}
            {sourceSummary.length === 0 && <p className="text-sm text-slate-500">データがありません</p>}
          </div>
        </section>

        <div className="flex flex-col lg:flex-row gap-8 items-start">
          {/* Filters Sidebar */}
          <aside className="w-full lg:w-64 bg-white rounded-xl shadow-sm border border-slate-200 p-5 shrink-0 sticky top-6">
            <h2 className="text-lg font-semibold mb-4 text-slate-800 border-b pb-2">絞り込み</h2>
            
            <div className="space-y-5">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">キーワード検索</label>
                <input 
                  type="text" 
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  placeholder="タイトル, 会社名..."
                  className="w-full p-2 border border-slate-300 rounded-md text-sm focus:ring-emerald-500 focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">判定で絞り込む</label>
                <select 
                  value={judgment}
                  onChange={(e) => setJudgment(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded-md text-sm bg-white"
                >
                  <option value="all">すべて</option>
                  <option value="通過">通過</option>
                  <option value="保留">保留</option>
                  <option value="除外">除外</option>
                  <option value="取得失敗">取得失敗</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">取得元サイト</label>
                <select 
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded-md text-sm bg-white"
                >
                  <option value="all">すべて</option>
                  {sourceSummary.map(s => <option key={s.source} value={s.source}>{s.source}</option>)}
                </select>
              </div>
              
              <div className="pt-2 border-t space-y-3">
                <label className="flex items-center space-x-2 cursor-pointer">
                  <input type="checkbox" checked={hasDormitory} onChange={(e)=>setHasDormitory(e.target.checked)} className="rounded text-emerald-600 focus:ring-emerald-500"/>
                  <span className="text-sm text-slate-700">寮・社宅あり優先</span>
                </label>
                <label className="flex items-center space-x-2 cursor-pointer">
                  <input type="checkbox" checked={welcomeInexperienced} onChange={(e)=>setWelcomeInexperienced(e.target.checked)} className="rounded text-emerald-600 focus:ring-emerald-500"/>
                  <span className="text-sm text-slate-700">未経験歓迎</span>
                </label>
                <label className="flex items-center space-x-2 cursor-pointer">
                  <input type="checkbox" checked={isNew} onChange={(e)=>setIsNew(e.target.checked)} className="rounded text-emerald-600 focus:ring-emerald-500"/>
                  <span className="text-sm font-medium text-purple-700">新着求人のみ</span>
                </label>
              </div>
            </div>
          </aside>

          {/* Job List */}
          <main className="flex-1 w-full">
            {isLoading ? (
              <div className="flex flex-col items-center justify-center p-20 bg-white rounded-xl shadow-sm border border-slate-200">
                <div className="w-10 h-10 border-4 border-emerald-200 border-t-emerald-600 rounded-full animate-spin"></div>
                <p className="mt-4 text-emerald-800 font-medium">データを読み込み中...</p>
              </div>
            ) : error ? (
              <div className="bg-red-50 text-red-700 p-6 rounded-xl border border-red-200 shadow-sm flex items-center justify-between">
                <div>
                  <h3 className="font-bold text-lg">エラーが発生しました</h3>
                  <p className="text-sm mt-1">{error}</p>
                </div>
                <button onClick={fetchDashboardData} className="px-4 py-2 bg-red-100 hover:bg-red-200 rounded-lg text-sm font-medium transition-colors">再試行</button>
              </div>
            ) : stats?.total === 0 ? (
              <div className="flex flex-col items-center justify-center p-20 bg-white rounded-xl shadow-sm border border-slate-200 text-center">
                <div className="text-emerald-300 mb-4">
                  <svg className="w-16 h-16 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
                  </svg>
                </div>
                <h3 className="text-lg font-bold text-slate-700">データベースに求人データがありません</h3>
                <p className="text-sm text-slate-500 mt-1">まだ収集スクリプトが実行されていないか、条件に合う求人が一件も収集されていません。</p>
                <div className="mt-8 flex gap-4 w-full max-w-md mx-auto">
                   <Link 
                    href="/agri-jobs/add"
                    className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg shadow-sm font-bold transition-colors"
                  >
                    テストデータを手動登録
                  </Link>
                  <button 
                    onClick={handleSeedData}
                    disabled={isImporting}
                    className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-white border border-slate-300 hover:bg-slate-50 disabled:bg-slate-50 text-slate-700 rounded-lg shadow-sm font-bold transition-all"
                  >
                    APIでシード投入
                  </button>
                </div>
                <div className="mt-6 p-4 bg-slate-50 border border-slate-200 rounded-lg text-left text-xs text-slate-600 font-mono w-full max-w-sm">
                  <p className="font-bold border-b border-slate-200 pb-1 mb-2">運用担当者へのご案内 (スクリプト実行時)</p>
                  <code>
                    cd /polar-opportunity<br/>
                    ./venv/bin/python main.py
                  </code>
                </div>
              </div>
            ) : jobs.length === 0 ? (
              <div className="flex flex-col items-center justify-center p-20 bg-white rounded-xl shadow-sm border border-slate-200 text-center">
                <div className="text-slate-300 mb-4">
                  <svg className="w-16 h-16 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 002-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                  </svg>
                </div>
                <h3 className="text-lg font-bold text-slate-700">条件に一致する求人がありません</h3>
                <p className="text-sm text-slate-500 mt-1">フィルター条件を変更してお試しください。</p>
                <button onClick={() => {setKeyword(''); setJudgment('all'); setSource('all'); setHasDormitory(false); setWelcomeInexperienced(false); setIsNew(false)}} className="mt-4 text-emerald-600 text-sm font-medium hover:underline">条件をリセット</button>
              </div>
            ) : (
              <div className="space-y-4">
                {jobs.map(job => (
                  <JobCard key={job.duplicate_key} job={job} />
                ))}
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

// Subcomponents
function StatCard({ title, value, color, highlight = false }: { title: string, value: number, color: string, highlight?: boolean }) {
  return (
    <div className={`p-4 rounded-xl border ${color} shadow-sm relative overflow-hidden transition-all hover:-translate-y-1 hover:shadow-md`}>
      {highlight && <div className="absolute top-0 right-0 w-16 h-16 bg-white/20 rounded-bl-full -mr-8 -mt-8"></div>}
      <p className="text-xs font-bold uppercase tracking-wider opacity-80">{title}</p>
      <p className="text-3xl font-extrabold mt-1">{value.toLocaleString()}</p>
    </div>
  );
}

function JobCard({ job }: { job: JobListing }) {
  
  const getBadgeColor = (judgement: string) => {
    switch (judgement) {
      case '通過': return 'bg-emerald-100 text-emerald-800 border-emerald-200';
      case '保留': return 'bg-amber-100 text-amber-800 border-amber-200';
      case '除外': return 'bg-slate-100 text-slate-600 border-slate-200';
      default: return 'bg-red-100 text-red-800 border-red-200';
    }
  };

  const formatJobDate = (dateString?: string) => {
    if (!dateString) return '日時未設定';
    try {
      const d = new Date(dateString);
      if (isNaN(d.getTime())) return '日時不明';
      
      const parts = new Intl.DateTimeFormat('ja-JP', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).formatToParts(d);
      
      const dict = Object.fromEntries(parts.map(p => [p.type, p.value]));
      return `${dict.year}/${dict.month}/${dict.day} ${dict.hour}:${dict.minute}`;
    } catch {
      return '日時不明';
    }
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden hover:shadow-md transition-shadow group relative">
      {job.is_new && (
        <div className="absolute top-0 right-0 bg-gradient-to-r from-purple-500 to-indigo-600 text-white text-[10px] font-bold px-3 py-1 rounded-bl-lg uppercase tracking-widest shadow-sm">
          New Arrival
        </div>
      )}
      
      <div className="p-5">
        <div className="flex justify-between items-start gap-4">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-2">
              <span className={`text-[11px] font-bold px-2 py-0.5 rounded-md border ${getBadgeColor(job.judgment)}`}>
                {job.judgment}
              </span>
              <span className="text-[11px] font-semibold text-slate-500 bg-slate-100 px-2 py-0.5 rounded-md">
                {job.source || job.source_site}
              </span>
              <span className="text-[11px] text-slate-400">
                {formatJobDate(job.first_seen_at)}
              </span>
            </div>
            
            <h3 className="text-lg font-bold text-slate-800 leading-tight group-hover:text-emerald-700 transition-colors">
              {job.title}
            </h3>
            <p className="text-sm font-medium text-slate-600 mt-1 flex items-center gap-1.5">
              <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" /></svg>
              {job.company}
            </p>
          </div>
          
          <div className="text-right shrink-0">
            <div className="bg-emerald-50 rounded-lg p-2 border border-emerald-100 inline-block text-center min-w-[70px]">
              <div className="text-[10px] text-emerald-600 font-bold uppercase">Final Score</div>
              <div className="text-xl font-black text-emerald-800 leading-none mt-1">{job.final_score}</div>
            </div>
            <div className="text-[10px] text-slate-400 mt-1">
              (R:{job.rule_score} | AI:{job.ai_score})
            </div>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
          <div className="bg-slate-50 rounded-md p-2 flex items-start gap-2 border border-slate-100">
            <svg className="w-4 h-4 text-slate-400 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
            <span className="text-slate-700 truncate">{job.location}</span>
          </div>
          <div className="bg-slate-50 rounded-md p-2 flex items-start gap-2 border border-slate-100">
            <svg className="w-4 h-4 text-slate-400 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            <span className="text-slate-700 font-medium">
              {job.salary_min > 0 ? `月給 ${job.salary_min}円〜` : '規定に準ずる'}
            </span>
          </div>
        </div>

        <div className="mt-4 space-y-2">
           <div className="text-sm">
             <span className="font-semibold text-slate-700 block mb-0.5">判定理由:</span>
             <p className="text-slate-600 bg-slate-50 p-2 rounded-md text-[13px] border border-slate-100">{job.judgment_reason}</p>
           </div>
           
           {job.ai_summary && (
             <div className="text-sm">
               <span className="font-semibold text-indigo-700 block mb-0.5 flex items-center gap-1">
                 <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" clipRule="evenodd" /></svg>
                 AI サマリー
               </span>
               <p className="text-indigo-900 bg-indigo-50 p-2 rounded-md text-[13px] border border-indigo-100">{job.ai_summary}</p>
             </div>
           )}
        </div>
        
        <div className="mt-5 pt-4 border-t border-slate-100 flex items-center justify-between">
          <div className="flex gap-2">
            {job.has_dormitory && <span className="text-[10px] font-bold text-orange-700 bg-orange-100 px-2 py-1 rounded">寮・社宅あり</span>}
            {job.welcome_inexperienced && <span className="text-[10px] font-bold text-blue-700 bg-blue-100 px-2 py-1 rounded">未経験歓迎</span>}
          </div>
          
          {(!job.source_url || ["https://jp.indeed.com/", "https://jp.indeed.com", "", "https://www.agri-navi.com/", "https://agrijob.jp/"].includes(job.source_url.trim()) || job.source_url.includes('simulated_')) ? (
            <span className="text-sm font-bold text-slate-400 flex items-center gap-1 cursor-not-allowed" title="詳細ページへの個別URLがありません">
              個別URL未設定
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
            </span>
          ) : (
            <a 
              href={job.source_url} 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-sm font-bold text-emerald-600 hover:text-emerald-800 flex items-center gap-1 transition-colors hover:underline"
            >
              詳細を見る
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
