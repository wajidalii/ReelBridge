import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiGet, apiPost } from './client.js';

export interface CurrentUser {
  id: string;
  email: string;
  emailVerified: boolean;
  createdAt: string;
}

export const ME_QUERY_KEY = ['auth', 'me'] as const;

/** null means "not logged in" — a 401 here is a normal state, not an error. */
export function useMe() {
  return useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: async (): Promise<CurrentUser | null> => {
      try {
        return await apiGet<CurrentUser>('/auth/me');
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          // The access cookie may just have expired; one refresh attempt
          // before concluding the user is logged out.
          const refreshed = await fetch('/api/auth/refresh', {
            method: 'POST',
            credentials: 'include',
          })
            .then((res) => res.ok)
            .catch(() => false);
          if (refreshed) {
            try {
              return await apiGet<CurrentUser>('/auth/me');
            } catch {
              return null;
            }
          }
          return null;
        }
        throw error;
      }
    },
    staleTime: 60_000,
    retry: false,
  });
}

interface AuthResponse {
  id: string;
  email: string;
  emailVerified: boolean;
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; password: string }) =>
      apiPost<AuthResponse>('/auth/login', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY }),
  });
}

export function useSignup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; password: string; invite_code?: string }) =>
      apiPost<AuthResponse>('/auth/signup', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY }),
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost<void>('/auth/logout', {}),
    onSuccess: () => {
      queryClient.setQueryData(ME_QUERY_KEY, null);
      queryClient.clear();
    },
  });
}

export interface SignupPolicy {
  mode: 'open' | 'invite';
}

export function useSignupPolicy() {
  return useQuery({
    queryKey: ['auth', 'signup-policy'],
    queryFn: () => apiGet<SignupPolicy>('/auth/signup-policy'),
    staleTime: Infinity,
  });
}

export function verifyEmail(token: string): Promise<{ verified: boolean }> {
  return apiPost<{ verified: boolean }>('/auth/verify-email', { token });
}

export function resendVerification(): Promise<{ sent: boolean; alreadyVerified?: boolean }> {
  return apiPost('/auth/resend-verification', {});
}

export function forgotPassword(email: string): Promise<{ message: string }> {
  return apiPost<{ message: string }>('/auth/forgot-password', { email });
}

export function resetPassword(token: string, password: string): Promise<{ reset: boolean }> {
  return apiPost<{ reset: boolean }>('/auth/reset-password', { token, password });
}
