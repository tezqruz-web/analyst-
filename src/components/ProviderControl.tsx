import React, { useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  Eye,
  EyeOff,
  KeyRound,
  Trash2,
  X,
} from 'lucide-react';
import type { AiProvider, ProviderSettings } from '../types';

export const PROVIDER_MODELS: Record<
  AiProvider,
  Array<{ id: string; label: string; note: string }>
> = {
  google: [
    {
      id: 'gemini-4-hydrogen',
      label: 'Gemini 4 Flash',
      note: 'Fast multi-step agent & direct chat',
    },
    {
      id: 'gemini-3.1-flash-lite',
      label: 'Gemini Flash Lite',
      note: 'Lightweight, lowest latency',
    },
    {
      id: 'gemini-managed-agent',
      label: 'Gemini Managed Agent',
      note: 'Python sandbox for CSV/Excel files',
    },
  ],
  deepseek: [
    {
      id: 'deepseek-chat',
      label: 'DeepSeek V3 (Chat)',
      note: 'Tool-calling data & general agent',
    },
    {
      id: 'deepseek-reasoner',
      label: 'DeepSeek R1 (Reasoner)',
      note: 'Deep step-by-step reasoning',
    },
  ],
};

interface ProviderControlProps {
  settings: ProviderSettings;
  onSave: (payload: {
    provider: AiProvider;
    model: string;
    googleApiKey?: string;
    deepseekApiKey?: string;
  }) => Promise<void>;
  onClearKey: (provider: AiProvider) => Promise<void>;
  disabled?: boolean;
  openSignal?: number;
}

export const ProviderControl: React.FC<ProviderControlProps> = ({
  settings,
  onSave,
  onClearKey,
  disabled = false,
  openSignal = 0,
}) => {
  const [open, setOpen] = useState(false);
  const [draftProvider, setDraftProvider] = useState<AiProvider>(settings.provider);
  const [draftModel, setDraftModel] = useState<string>(settings.model);
  const [googleKeyInput, setGoogleKeyInput] = useState('');
  const [deepseekKeyInput, setDeepseekKeyInput] = useState('');
  const [showGoogleKey, setShowGoogleKey] = useState(false);
  const [showDeepseekKey, setShowDeepseekKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setDraftProvider(settings.provider);
    setDraftModel(settings.model);
  }, [settings.provider, settings.model]);

  useEffect(() => {
    if (openSignal > 0) {
      setOpen(true);
    }
  }, [openSignal]);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [open]);

  const activeProviderLabel =
    settings.provider === 'deepseek' ? 'DeepSeek' : 'Google Gemini';
  const activeModelMeta =
    PROVIDER_MODELS[settings.provider].find((m) => m.id === settings.model) ||
    PROVIDER_MODELS[settings.provider][0];

  const hasActiveProviderKey =
    settings.provider === 'google' ? settings.hasGoogleKey : settings.hasDeepseekKey;

  const handleSelectProvider = (next: AiProvider) => {
    setDraftProvider(next);
    const defaultModel = PROVIDER_MODELS[next][0].id;
    setDraftModel(defaultModel);
    setFeedback(null);
  };

  const handleQuickSwitch = async (nextProvider: AiProvider) => {
    if (disabled || saving || nextProvider === settings.provider) return;
    setSaving(true);
    setFeedback(null);
    try {
      const nextModel = PROVIDER_MODELS[nextProvider][0].id;
      await onSave({ provider: nextProvider, model: nextModel });
      const targetHasKey =
        nextProvider === 'google' ? settings.hasGoogleKey : settings.hasDeepseekKey;
      if (!targetHasKey) {
        setOpen(true);
      }
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'Failed to switch provider.' });
      setOpen(true);
    } finally {
      setSaving(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setFeedback(null);
    try {
      await onSave({
        provider: draftProvider,
        model: draftModel,
        ...(googleKeyInput.trim() ? { googleApiKey: googleKeyInput.trim() } : {}),
        ...(deepseekKeyInput.trim() ? { deepseekApiKey: deepseekKeyInput.trim() } : {}),
      });
      setGoogleKeyInput('');
      setDeepseekKeyInput('');
      setFeedback({ type: 'ok', text: 'Saved' });
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'Could not save settings.' });
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async (target: AiProvider) => {
    if (saving) return;
    setSaving(true);
    setFeedback(null);
    try {
      await onClearKey(target);
      setFeedback({
        type: 'ok',
        text: `${target === 'google' ? 'Google' : 'DeepSeek'} key removed.`,
      });
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'Failed to remove key.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div ref={containerRef} className="relative flex items-center gap-2 shrink-0">
      {/* Compact segmented quick switcher in top-right corner */}
      <div
        className="hidden sm:flex items-center p-0.5 rounded-lg bg-neutral-200/75 border border-neutral-200"
        role="group"
        aria-label="AI Provider"
      >
        <button
          type="button"
          disabled={disabled || saving}
          onClick={() => handleQuickSwitch('google')}
          className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
            settings.provider === 'google'
              ? 'bg-white text-neutral-900 shadow-2xs'
              : 'text-neutral-600 hover:text-neutral-900'
          }`}
        >
          Google Gemini
        </button>
        <button
          type="button"
          disabled={disabled || saving}
          onClick={() => handleQuickSwitch('deepseek')}
          className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
            settings.provider === 'deepseek'
              ? 'bg-white text-neutral-900 shadow-2xs'
              : 'text-neutral-600 hover:text-neutral-900'
          }`}
        >
          DeepSeek
        </button>
      </div>

      {/* Model & API Key Trigger Button */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setOpen((v) => !v);
          setFeedback(null);
        }}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-neutral-300 bg-white hover:border-neutral-400 text-xs font-medium text-neutral-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
        aria-expanded={open}
      >
        <KeyRound className="h-3.5 w-3.5 text-neutral-600 shrink-0" />
        <span className="max-w-[140px] truncate">
          <span className="sm:hidden">{activeProviderLabel} · </span>
          {activeModelMeta.label}
        </span>
        {!hasActiveProviderKey && (
          <span className="text-[11px] font-semibold text-amber-700">Key needed</span>
        )}
        <ChevronDown
          className={`h-3.5 w-3.5 text-neutral-500 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {/* Clean Dropdown Panel */}
      {open && (
        <div className="absolute right-0 top-full mt-2 w-[360px] max-w-[calc(100vw-24px)] rounded-xl border border-neutral-200 bg-white shadow-xl z-50 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-100">
            <h3 className="text-sm font-semibold text-neutral-900">AI Provider &amp; Keys</h3>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="p-1 rounded-md text-neutral-400 hover:text-neutral-700 hover:bg-neutral-100 cursor-pointer"
              aria-label="Close AI provider settings"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <form onSubmit={handleSubmit} className="p-4 space-y-4">
            {/* Provider Tabs */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-neutral-700">AI Provider</label>
              <div className="grid grid-cols-2 gap-1.5 p-1 rounded-lg bg-neutral-100">
                <button
                  type="button"
                  onClick={() => handleSelectProvider('google')}
                  className={`py-2 px-3 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                    draftProvider === 'google'
                      ? 'bg-white text-neutral-900 shadow-2xs'
                      : 'text-neutral-600 hover:text-neutral-900'
                  }`}
                >
                  Google Gemini
                </button>
                <button
                  type="button"
                  onClick={() => handleSelectProvider('deepseek')}
                  className={`py-2 px-3 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                    draftProvider === 'deepseek'
                      ? 'bg-white text-neutral-900 shadow-2xs'
                      : 'text-neutral-600 hover:text-neutral-900'
                  }`}
                >
                  DeepSeek
                </button>
              </div>
            </div>

            {/* Model Selector */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-neutral-700">Model</label>
              <div className="space-y-1.5">
                {PROVIDER_MODELS[draftProvider].map((m) => {
                  const selected = draftModel === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setDraftModel(m.id)}
                      className={`w-full text-left px-3 py-2 rounded-lg border transition-colors cursor-pointer ${
                        selected
                          ? 'border-neutral-900 bg-neutral-50'
                          : 'border-neutral-200 hover:border-neutral-300 bg-white'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-neutral-900">{m.label}</span>
                        {selected && <Check className="h-3.5 w-3.5 text-neutral-900 shrink-0" />}
                      </div>
                      <p className="text-[11px] text-neutral-500 mt-0.5">{m.note}</p>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* API Key Input for Selected Provider */}
            {draftProvider === 'google' ? (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-neutral-700">
                    Google Gemini API Key
                  </label>
                  {settings.hasGoogleKey ? (
                    <span className="text-[11px] font-mono text-emerald-700">
                      Saved: {settings.googleKeyHint}
                    </span>
                  ) : (
                    <span className="text-[11px] text-amber-700">Required</span>
                  )}
                </div>
                <div className="relative flex items-center">
                  <input
                    type={showGoogleKey ? 'text' : 'password'}
                    value={googleKeyInput}
                    onChange={(e) => setGoogleKeyInput(e.target.value)}
                    placeholder={
                      settings.hasGoogleKey
                        ? 'Enter new key to replace saved key'
                        : 'AIza...'
                    }
                    autoComplete="off"
                    className="w-full pl-3 pr-9 py-2 text-xs font-mono rounded-lg border border-neutral-300 focus:border-neutral-900 outline-none bg-white"
                  />
                  <button
                    type="button"
                    onClick={() => setShowGoogleKey((v) => !v)}
                    className="absolute right-2.5 text-neutral-400 hover:text-neutral-700 cursor-pointer"
                    aria-label="Toggle Google API key visibility"
                  >
                    {showGoogleKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                </div>
                {settings.hasGoogleKey && (
                  <button
                    type="button"
                    onClick={() => handleClear('google')}
                    disabled={saving}
                    className="inline-flex items-center gap-1 text-[11px] text-red-600 hover:text-red-700 font-medium cursor-pointer"
                  >
                    <Trash2 className="h-3 w-3" />
                    Remove saved key
                  </button>
                )}
              </div>
            ) : (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-neutral-700">
                    DeepSeek API Key
                  </label>
                  {settings.hasDeepseekKey ? (
                    <span className="text-[11px] font-mono text-emerald-700">
                      Saved: {settings.deepseekKeyHint}
                    </span>
                  ) : (
                    <span className="text-[11px] text-amber-700">Required</span>
                  )}
                </div>
                <div className="relative flex items-center">
                  <input
                    type={showDeepseekKey ? 'text' : 'password'}
                    value={deepseekKeyInput}
                    onChange={(e) => setDeepseekKeyInput(e.target.value)}
                    placeholder={
                      settings.hasDeepseekKey
                        ? 'Enter new key to replace saved key'
                        : 'sk-...'
                    }
                    autoComplete="off"
                    className="w-full pl-3 pr-9 py-2 text-xs font-mono rounded-lg border border-neutral-300 focus:border-neutral-900 outline-none bg-white"
                  />
                  <button
                    type="button"
                    onClick={() => setShowDeepseekKey((v) => !v)}
                    className="absolute right-2.5 text-neutral-400 hover:text-neutral-700 cursor-pointer"
                    aria-label="Toggle DeepSeek API key visibility"
                  >
                    {showDeepseekKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                </div>
                {settings.hasDeepseekKey && (
                  <button
                    type="button"
                    onClick={() => handleClear('deepseek')}
                    disabled={saving}
                    className="inline-flex items-center gap-1 text-[11px] text-red-600 hover:text-red-700 font-medium cursor-pointer"
                  >
                    <Trash2 className="h-3 w-3" />
                    Remove saved key
                  </button>
                )}
              </div>
            )}

            {feedback && (
              <p
                className={`text-xs font-medium ${
                  feedback.type === 'ok' ? 'text-emerald-700' : 'text-red-600'
                }`}
              >
                {feedback.text}
              </p>
            )}

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-neutral-100">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium text-neutral-600 hover:text-neutral-900 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-1.5 rounded-lg bg-neutral-900 hover:bg-neutral-800 text-white text-xs font-semibold transition-colors disabled:opacity-50 cursor-pointer"
              >
                {saving ? 'Saving...' : 'Save Settings'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
