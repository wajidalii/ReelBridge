import { Link } from 'react-router-dom';
import { useConfig } from '../api/useConfig.js';

interface PlatformCardProps {
  title: string;
  description: string;
  children: React.ReactNode;
}

function PlatformCard({ title, description, children }: PlatformCardProps) {
  return (
    <div className="flex flex-col rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h3 className="text-base font-semibold text-slate-900">{title}</h3>
      <p className="mt-1 flex-1 text-sm text-slate-600">{description}</p>
      <div className="mt-4">{children}</div>
    </div>
  );
}

const primaryButtonClasses =
  'inline-flex items-center rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white ' +
  'shadow-sm transition hover:bg-brand-700';
const secondaryLinkClasses = 'text-sm font-medium text-brand-600 hover:underline';

export function Onboarding() {
  const { data: config, isLoading } = useConfig();
  // Fail closed (treat as not-yet-approved) while loading or if the request
  // fails — a false "connect" button that 400s is worse than a brief gating
  // notice that clears once /api/config resolves.
  const metaApproved = config?.metaAppReviewApproved === true;

  return (
    <div className="max-w-3xl">
      <h1 className="text-3xl font-bold tracking-tight text-slate-900">
        Connect a platform to get started
      </h1>
      <p className="mt-3 text-lg text-slate-600">
        Pick a platform below. Once it's connected you can bulk-upload and schedule Reels to it.
      </p>

      <div className="mt-8 grid gap-6 sm:grid-cols-3">
        <PlatformCard title="Facebook" description="Post Reels directly to a Facebook Page.">
          {!isLoading && !metaApproved && (
            <p className="text-sm font-medium text-amber-700">
              Currently invite-only while we complete Meta&apos;s App Review. You can still
              connect a Page manually below.
            </p>
          )}
          <div className="mt-3 flex flex-col items-start gap-2">
            {metaApproved && (
              <Link to="/connect/facebook?intent=facebook" className={primaryButtonClasses}>
                Connect Facebook
              </Link>
            )}
            <Link to="/connect/facebook?intent=facebook" className={secondaryLinkClasses}>
              Connect a Page manually
            </Link>
          </div>
        </PlatformCard>

        <PlatformCard
          title="Instagram"
          description="Post Reels to an Instagram Business account linked to a Facebook Page."
        >
          {!isLoading && !metaApproved ? (
            <p className="text-sm font-medium text-amber-700">
              Currently invite-only while we complete Meta&apos;s App Review. Check back once
              that clears to connect Instagram.
            </p>
          ) : (
            <Link to="/connect/facebook?intent=instagram" className={primaryButtonClasses}>
              Connect Instagram
            </Link>
          )}
        </PlatformCard>

        <PlatformCard
          title="YouTube"
          description="Post Reels as YouTube Shorts to a channel you manage."
        >
          <p className="text-sm font-medium text-slate-500">
            Not available yet — YouTube support is still in development.
          </p>
        </PlatformCard>
      </div>
    </div>
  );
}
