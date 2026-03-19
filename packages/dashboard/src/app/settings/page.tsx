export default function SettingsPage() {
  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Settings</h2>

      <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
        <h3 className="text-lg font-semibold mb-4">Fleet Configuration</h3>
        <p className="text-gray-400 text-sm mb-4">
          Edit <code className="bg-gray-800 px-1 rounded">botforge.yaml</code> at the project root to configure fleet settings.
        </p>

        <div className="space-y-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Dashboard Password</label>
            <p className="text-sm text-gray-500">
              Set via <code className="bg-gray-800 px-1 rounded">DASHBOARD_PASSWORD</code> environment variable.
            </p>
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">Health API Token</label>
            <p className="text-sm text-gray-500">
              Set via <code className="bg-gray-800 px-1 rounded">HEALTH_API_TOKEN</code> environment variable.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
