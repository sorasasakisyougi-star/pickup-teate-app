"use client";

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function AddJobPage() {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [formData, setFormData] = useState({
    title: '',
    company: '',
    location: '',
    salary_min: '',
    employment_status: '正社員',
    source: 'Manual entry',
    source_url: '',
    judgment: '未判定',
    rule_score: '0',
    ai_score: '0',
    final_score: '0',
    judgment_reason: '',
    has_dormitory: false,
    welcome_inexperienced: false,
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value, type } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? (e.target as HTMLInputElement).checked : value
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);

    // Calculate final score if omitted
    const rScore = Number(formData.rule_score) || 0;
    const aScore = Number(formData.ai_score) || 0;
    const fScore = Number(formData.final_score) || (rScore + aScore);

    const payload = {
      ...formData,
      salary_min: Number(formData.salary_min) || 0,
      rule_score: rScore,
      ai_score: aScore,
      final_score: fScore,
    };

    try {
      const res = await fetch('/api/jobs/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();

      if (res.ok) {
        alert('求人を登録しました！');
        router.push('/agri-jobs');
        router.refresh();
      } else {
        setError(data.error || '登録に失敗しました');
      }
    } catch (err: any) {
      setError(`通信エラーが発生しました: ${err.message}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 p-6 font-sans">
      <div className="max-w-3xl mx-auto bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        
        <div className="bg-emerald-700 px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-white">手動データ登録フォーム</h1>
            <p className="text-emerald-100 text-sm mt-1">ダッシュボードに表示する農業求人を1件ずつ投入します</p>
          </div>
          <button 
            onClick={() => router.push('/agri-jobs')}
            className="text-sm bg-emerald-800 hover:bg-emerald-900 border border-emerald-600 text-white px-3 py-1.5 rounded transition-colors"
          >
            戻る
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          {error && (
            <div className="p-4 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm font-medium">
              {error}
            </div>
          )}

          <div className="space-y-4">
            <h2 className="text-sm font-bold text-slate-500 uppercase tracking-widest border-b pb-2">基本情報</h2>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">求人タイトル <span className="text-red-500">*</span></label>
                <input required type="text" name="title" value={formData.title} onChange={handleChange} className="w-full p-2 border border-slate-300 rounded-md focus:ring-emerald-500 focus:border-emerald-500 text-sm" placeholder="【急募】トマト栽培スタッフ" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">会社名 / 農園名 <span className="text-red-500">*</span></label>
                <input required type="text" name="company" value={formData.company} onChange={handleChange} className="w-full p-2 border border-slate-300 rounded-md focus:ring-emerald-500 focus:border-emerald-500 text-sm" placeholder="株式会社 サンプル農園" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">勤務地 (Location) <span className="text-red-500">*</span></label>
                <input required type="text" name="location" value={formData.location} onChange={handleChange} className="w-full p-2 border border-slate-300 rounded-md focus:ring-emerald-500 focus:border-emerald-500 text-sm" placeholder="北海道 帯広市" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">給与 (月給下限 / Salary Min)</label>
                <input type="number" name="salary_min" value={formData.salary_min} onChange={handleChange} className="w-full p-2 border border-slate-300 rounded-md focus:ring-emerald-500 focus:border-emerald-500 text-sm" placeholder="250000" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">雇用形態</label>
                <select name="employment_status" value={formData.employment_status} onChange={handleChange} className="w-full p-2 border border-slate-300 rounded-md bg-white text-sm">
                  <option value="正社員">正社員</option>
                  <option value="契約社員">契約社員</option>
                  <option value="アルバイト・パート">アルバイト・パート</option>
                  <option value="派遣社員">派遣社員</option>
                  <option value="不明">不明</option>
                </select>
              </div>
            </div>

            <div className="flex gap-6 py-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" name="has_dormitory" checked={formData.has_dormitory} onChange={handleChange} className="rounded text-emerald-600 focus:ring-emerald-500 w-4 h-4" />
                <span className="text-sm font-medium text-slate-700">寮・社宅あり</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" name="welcome_inexperienced" checked={formData.welcome_inexperienced} onChange={handleChange} className="rounded text-emerald-600 focus:ring-emerald-500 w-4 h-4" />
                <span className="text-sm font-medium text-slate-700">未経験歓迎</span>
              </label>
            </div>
          </div>

          <div className="space-y-4">
            <h2 className="text-sm font-bold text-slate-500 uppercase tracking-widest border-b pb-2">メタデータ・判定情報</h2>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">判定 (Judgment)</label>
                <select name="judgment" value={formData.judgment} onChange={handleChange} className="w-full p-2 border border-slate-300 rounded-md bg-white text-sm">
                  <option value="通過">通過</option>
                  <option value="保留">保留</option>
                  <option value="除外">除外</option>
                  <option value="未判定">未判定</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">情報元サイト名 (Source)</label>
                <input type="text" name="source" value={formData.source} onChange={handleChange} className="w-full p-2 border border-slate-300 rounded-md text-sm" placeholder="AgriNavi 手動登録" />
              </div>
              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-slate-700 mb-1">情報元URL (任意)</label>
                <input type="url" name="source_url" value={formData.source_url} onChange={handleChange} className="w-full p-2 border border-slate-300 rounded-md text-sm text-blue-600" placeholder="https://example.com/job/123" />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">ルールスコア</label>
                <input type="number" name="rule_score" value={formData.rule_score} onChange={handleChange} className="w-full p-2 border border-slate-300 rounded-md text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">AIスコア</label>
                <input type="number" name="ai_score" value={formData.ai_score} onChange={handleChange} className="w-full p-2 border border-slate-300 rounded-md text-sm" />
              </div>
              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-slate-700 mb-1">自動判定サマリー / コメント (Summary)</label>
                <textarea name="judgment_reason" value={formData.judgment_reason} onChange={handleChange} rows={3} className="w-full p-2 border border-slate-300 rounded-md text-sm" placeholder="手動で「通過」とした理由など"></textarea>
              </div>
            </div>
          </div>

          <div className="pt-4 border-t border-slate-200 flex justify-end gap-3">
            <button 
              type="button" 
              onClick={() => router.push('/agri-jobs')}
              className="px-4 py-2 border border-slate-300 text-slate-600 font-medium rounded-lg hover:bg-slate-50 transition-colors"
            >
              キャンセル
            </button>
            <button 
              type="submit" 
              disabled={isSubmitting}
              className="px-6 py-2 bg-emerald-600 text-white font-bold rounded-lg shadow-sm hover:bg-emerald-700 transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              {isSubmitting ? (
                <>
                  <svg className="animate-spin h-5 w-5 text-white" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                  保存中...
                </>
              ) : '登録してデータベースに保存'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
