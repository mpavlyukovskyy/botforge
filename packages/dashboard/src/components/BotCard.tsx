"use client";

interface BotCardProps {
  name: string;
  description?: string;
  platform?: string;
  brain?: string;
  status: string;
  onEdit: () => void;
  onStart: () => void;
  onStop: () => void;
  isLoading?: boolean;
}

const statusColors: Record<string, string> = {
  healthy: "bg-green-500",
  offline: "bg-red-500",
  error: "bg-yellow-500",
  deploying: "bg-blue-500",
  unknown: "bg-gray-500",
};

export function BotCard({ name, description, platform, brain, status, onEdit, onStart, onStop, isLoading }: BotCardProps) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-lg">{name}</h3>
        <span className="flex items-center gap-2 text-sm text-gray-400">
          <span className={`inline-block w-2 h-2 rounded-full ${statusColors[status] ?? statusColors.unknown}`} />
          {status}
        </span>
      </div>
      {description && <p className="text-sm text-gray-400">{description}</p>}
      <div className="flex gap-4 text-xs text-gray-500">
        {platform && <span>Platform: {platform}</span>}
        {brain && <span>Brain: {brain}</span>}
      </div>
      <div className="flex gap-2 mt-auto pt-2 border-t border-gray-800">
        <button
          onClick={onEdit}
          className="px-3 py-1.5 text-sm bg-gray-800 hover:bg-gray-700 rounded"
        >
          Edit
        </button>
        {status === "healthy" ? (
          <button
            onClick={onStop}
            disabled={isLoading}
            className="px-3 py-1.5 text-sm bg-red-900/50 hover:bg-red-900 text-red-300 rounded disabled:opacity-50"
          >
            Stop
          </button>
        ) : (
          <button
            onClick={onStart}
            disabled={isLoading}
            className="px-3 py-1.5 text-sm bg-green-900/50 hover:bg-green-900 text-green-300 rounded disabled:opacity-50"
          >
            Start
          </button>
        )}
      </div>
    </div>
  );
}
