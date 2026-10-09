import { useState, useEffect } from "react";
import { Navigate, useNavigate, useLocation } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  Eye,
  EyeOff,
  Lock,
  Mail,
  User,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "sonner";
import BrandDoodles from "@/components/shared/BrandDoodles";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/lib/supabase";
import { queryClient } from "@/lib/queryClient";
import { beginSession } from "@/lib/session";
import { useMe } from "@/lib/queries";
import sound from "@/lib/sound";
import Skeleton from "@/components/skeletons/Skeleton";
import { cn } from "@/lib/utils";


const ROLES = [
  { value: "sales", label: "Sales" },
  { value: "ops", label: "Operations" },
  { value: "finance", label: "Finance" },
  { value: "finance_manager", label: "Finance Manager" },
  { value: "admin", label: "Admin" },
];

export default function Login({ initialMode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { data: me, isLoading: meLoading } = useMe();

  // Mode: "signin" | "signup" | "forgot" | "update_password"
  const [mode, setMode] = useState(() => {
    if (initialMode) return initialMode;
    if (typeof window !== "undefined") {
      if (
        window.location.hash.includes("type=recovery") ||
        window.location.search.includes("mode=reset") ||
        window.location.search.includes("type=recovery")
      ) {
        return "update_password";
      }
    }
    return location.pathname === "/signup" ? "signup" : "signin";
  });

  useEffect(() => {
    if (initialMode) {
      setMode(initialMode);
    } else if (
      window.location.hash.includes("type=recovery") ||
      window.location.search.includes("mode=reset") ||
      window.location.search.includes("type=recovery")
    ) {
      setMode("update_password");
    } else if (location.pathname === "/signup") {
      setMode("signup");
    } else if (location.pathname === "/login") {
      setMode((prev) => (prev === "forgot" || prev === "update_password" ? prev : "signin"));
    }

    const { data: authListener } = supabase.auth.onAuthStateChange(async (event) => {
      if (event === "PASSWORD_RECOVERY") {
        setMode("update_password");
        sound.notification();
        toast.info("Security verified. Please enter your new password.");
      }
    });

    return () => {
      authListener?.subscription?.unsubscribe();
    };
  }, [location.pathname, initialMode]);

  // Sign In state
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  // Sign Up state
  const [signupName, setSignupName] = useState("");
  const [signupEmail, setSignupEmail] = useState("");
  const [signupRole, setSignupRole] = useState("sales");
  const [signupPassword, setSignupPassword] = useState("");
  const [signupConfirmPassword, setSignupConfirmPassword] = useState("");
  const [showSignupPassword, setShowSignupPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [authStatus, setAuthStatus] = useState(null);

  const checkEmailAuthorization = async (emailInput) => {
    const clean = (emailInput || "").trim().toLowerCase();
    if (!clean || !clean.includes("@")) {
      setAuthStatus(null);
      return;
    }
    try {
      const { data } = await supabase
        .from("authorized_users")
        .select("*")
        .eq("email", clean)
        .maybeSingle();

      if (data) {
        setAuthStatus({ authorized: true, name: data.name, role: data.role });
        if (!signupName.trim()) setSignupName(data.name);
        if (data.role) setSignupRole(data.role);
      } else {
        setAuthStatus({ authorized: false });
      }
    } catch {
      // ignore
    }
  };

  // Forgot Password state
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotSubmitted, setForgotSubmitted] = useState(false);

  // Update New Password state
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmNewPassword, setShowConfirmNewPassword] = useState(false);

  // Sign In Mutation
  const login = useMutation({
    mutationFn: async ({ email, password }) => {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      });
      if (error) throw error;
      if (!data?.user) throw new Error("No user returned from authentication.");

      const { data: profile } = await supabase
        .from("profiles")
        .select("name, role")
        .eq("id", data.user.id)
        .maybeSingle();

      const ROLE_LABELS = {
        admin: "Admin",
        sales: "Sales",
        ops: "Operations",
        finance: "Finance",
        finance_manager: "Finance Manager",
      };

      return {
        id: data.user.id,
        email: data.user.email,
        name: profile?.name ?? data.user.email?.split("@")[0] ?? "User",
        role: profile?.role ?? "sales",
        role_label: ROLE_LABELS[profile?.role] ?? profile?.role ?? "Sales",
      };
    },
    onSuccess: (user) => {
      sound.authSuccess();
      beginSession();
      queryClient.invalidateQueries({ queryKey: ["me"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      toast.success(`Signed in as ${user.name} · ${user.role_label}`);
      navigate("/dashboard");
    },
    onError: (err) => {
      sound.warning();
      toast.error(err?.message ?? "Sign in failed");
    },
  });

  // Sign Up Mutation with Whitelist Verification
  const signup = useMutation({
    mutationFn: async ({ name, email, role, password, confirmPassword }) => {
      const cleanEmail = email.trim().toLowerCase();
      if (!name.trim()) throw new Error("Please enter your full name.");
      if (!cleanEmail) throw new Error("Please enter your work email.");
      if (password.length < 6) throw new Error("Password must be at least 6 characters.");
      if (password !== confirmPassword) throw new Error("Passwords do not match.");

      // Check if email is in the authorized_users whitelist table
      const { data: authRecord, error: authErr } = await supabase
        .from("authorized_users")
        .select("*")
        .eq("email", cleanEmail)
        .maybeSingle();

      if (authErr) {
        console.error("Authorization check error:", authErr);
      }

      if (!authRecord) {
        throw new Error(
          "Access Restricted: This email is not authorized to create an account on Carbon & Whale IMS. Please contact an administrator."
        );
      }

      // Enforce the pre-assigned role and name
      const assignedRole = authRecord.role || role || "sales";
      const assignedName = name.trim() || authRecord.name;

      const { data, error } = await supabase.auth.signUp({
        email: cleanEmail,
        password,
        options: {
          data: {
            name: assignedName,
            role: assignedRole,
          },
        },
      });
      if (error) throw error;
      if (!data?.user) throw new Error("Sign up failed.");

      // Mark user as registered in authorized_users
      await supabase
        .from("authorized_users")
        .update({ is_registered: true, registered_at: new Date().toISOString() })
        .eq("email", cleanEmail);

      // Ensure profile record is updated/created
      await supabase.from("profiles").upsert({
        id: data.user.id,
        name: assignedName,
        email: cleanEmail,
        role: assignedRole,
        active: true,
      });

      const ROLE_LABELS = {
        admin: "Admin",
        sales: "Sales",
        ops: "Operations",
        finance: "Finance",
        finance_manager: "Finance Manager",
      };

      return {
        id: data.user.id,
        email: data.user.email,
        name: assignedName,
        role: assignedRole,
        role_label: ROLE_LABELS[assignedRole] ?? "Sales",
      };
    },
    onSuccess: (user) => {
      sound.authSuccess();
      beginSession();
      queryClient.invalidateQueries({ queryKey: ["me"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      toast.success(`Account created! Welcome, ${user.name}`);
      navigate("/dashboard");
    },
    onError: (err) => {
      sound.warning();
      toast.error(err?.message ?? "Sign up failed");
    },
  });

  // Forgot Password Mutation
  const forgot = useMutation({
    mutationFn: async (targetEmail) => {
      const cleanEmail = targetEmail.trim().toLowerCase();
      if (!cleanEmail) throw new Error("Please enter your work email.");

      // Check if user is an authorized staff member
      const { data: authRecord } = await supabase
        .from("authorized_users")
        .select("email, is_registered, name")
        .eq("email", cleanEmail)
        .maybeSingle();

      if (!authRecord) {
        throw new Error(
          "Account not found: This email is not registered with Carbon & Whale IMS. Please verify your email or contact an administrator."
        );
      }

      const redirectUrl = `${window.location.origin}/login?mode=reset`;
      const { error } = await supabase.auth.resetPasswordForEmail(cleanEmail, {
        redirectTo: redirectUrl,
      });

      if (error) {
        if (
          error.message?.toLowerCase().includes("recovery email") ||
          error.status === 500 ||
          error.message?.toLowerCase().includes("rate limit") ||
          error.message?.toLowerCase().includes("unexpected_failure")
        ) {
          throw new Error(
            "Supabase SMTP Error: The authentication service could not dispatch the recovery email. Please check your Supabase Custom SMTP configuration or contact an administrator."
          );
        }
        throw error;
      }
      return true;
    },
    onSuccess: () => {
      sound.success();
      setForgotSubmitted(true);
      toast.success("Password reset instructions sent to your email.");
    },
    onError: (err) => {
      sound.warning();
      toast.error(err?.message ?? "Failed to send reset email", {
        duration: 6000,
      });
    },
  });

  // Update New Password Mutation (Password Recovery)
  const updatePassword = useMutation({
    mutationFn: async ({ newPassword, confirmNewPassword }) => {
      if (!newPassword || newPassword.length < 6) {
        throw new Error("Password must be at least 6 characters.");
      }
      if (newPassword !== confirmNewPassword) {
        throw new Error("Passwords do not match.");
      }
      const { error } = await supabase.auth.updateUser({
        password: newPassword,
      });
      if (error) throw error;
      return true;
    },
    onSuccess: () => {
      sound.authSuccess();
      beginSession();
      queryClient.invalidateQueries({ queryKey: ["me"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      toast.success("Password updated successfully! Welcome back.");
      navigate("/dashboard");
    },
    onError: (err) => {
      sound.warning();
      toast.error(err?.message ?? "Failed to update password");
    },
  });

  // Show skeleton while session is resolving
  if (meLoading) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background p-4">
        <div className="w-full max-w-md space-y-4 rounded-2xl border border-border/70 bg-card/60 p-8 shadow-sm">
          <div className="space-y-2 text-center flex flex-col items-center">
            <Skeleton className="size-12 rounded-2xl" />
            <Skeleton className="h-6 w-36" />
            <Skeleton className="h-4 w-48" />
          </div>
          <div className="space-y-3 pt-4">
            <Skeleton className="h-10 w-full rounded-lg" />
            <Skeleton className="h-10 w-full rounded-lg" />
            <Skeleton className="h-10 w-full rounded-lg" />
          </div>
        </div>
      </div>
    );
  }

  // If already logged in, redirect to dashboard (unless in update_password recovery mode)
  if (me?.id && mode !== "update_password") {
    const from = location.state?.from || "/dashboard";
    return <Navigate to={from} replace />;
  }

  const isSignUp = mode === "signup";

  return (
    <div className="relative min-h-screen w-full overflow-x-hidden bg-background">
      <div className="flex min-h-screen w-full flex-col lg:flex-row">
        {/* HERO BANNER
            In Sign In: Order 1 (Left on desktop)
            In Sign Up: Order 2 (Right on desktop)
        */}
        <motion.div
          layout
          transition={{ type: "spring", stiffness: 180, damping: 25 }}
          className={cn(
            "relative hidden flex-col justify-between overflow-hidden bg-gradient-to-br from-[#002b3d] via-[#004c69] to-[#00668a] px-12 py-14 text-white lg:flex lg:w-[52%]",
            isSignUp ? "order-2" : "order-1"
          )}
        >
          <div
            className="absolute inset-0 opacity-35 mix-blend-overlay transition-all duration-500"
            style={{
              backgroundImage: isSignUp ? "url(/auth/signup.png)" : "url(/auth/signin.png)",
              backgroundSize: "cover",
              backgroundPosition: "center",
            }}
          />

          <div className="relative">
            <div className="flex items-center gap-2.5">
              <div className="flex size-10 items-center justify-center rounded-xl bg-white/10 p-1.5 shadow-xs backdrop-blur-xs border border-white/20">
                <img src="/brand/logo.svg" alt="Carbon & Whale" className="h-full w-full object-contain" />
              </div>
              <div>
                <span className="font-heading text-lg font-bold tracking-tight text-white">Carbon &amp; Whale</span>
                <p className="mono-label text-[10px] text-white/70">IMS · Ad Inventory System</p>
              </div>
            </div>

            <AnimatePresence mode="wait">
              {isSignUp ? (
                <motion.div
                  key="hero-signup"
                  initial={{ opacity: 0, y: 15 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -15 }}
                  transition={{ duration: 0.3 }}
                >
                  <h1 className="mt-14 max-w-lg font-heading text-4xl font-bold leading-[1.15] tracking-tight xl:text-5xl text-white">
                    Join the sustainable outdoor advertising network.
                  </h1>
                  <p className="mt-5 max-w-md text-sm leading-relaxed text-white/80">
                    Empower your team with a shared operational workflow — active queue reservations,
                    verifiable proof-of-performance photo geotagging, and an immutable corporate audit trail.
                  </p>
                </motion.div>
              ) : (
                <motion.div
                  key="hero-signin"
                  initial={{ opacity: 0, y: 15 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -15 }}
                  transition={{ duration: 0.3 }}
                >
                  <h1 className="mt-14 max-w-lg font-heading text-4xl font-bold leading-[1.15] tracking-tight xl:text-5xl text-white">
                    Sustainable outdoor media, from interest to release.
                  </h1>
                  <p className="mt-5 max-w-md text-sm leading-relaxed text-white/80">
                    Environmental stewardship meets operational excellence — visible waitlists,
                    business-day expiry in IST, geo-tagged proof cycles and an immutable audit trail.
                  </p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <div className="relative grid max-w-lg grid-cols-3 gap-6 pt-8 border-t border-white/15">
            {isSignUp
              ? [
                  ["Multi-role", "Cross-team workflows"],
                  ["Audit-grade", "Immutable change logs"],
                  ["Geo-tagged", "Real-time field proofs"],
                ].map(([v, l]) => (
                  <div key={l}>
                    <p className="font-heading text-2xl font-bold text-[#c3e7ff] xl:text-3xl">{v}</p>
                    <p className="mono-label mt-1 text-white/70 text-[10px]">{l}</p>
                  </div>
                ))
              : [
                  ["5", "business-day active slot"],
                  ["28", "day GTP cadence"],
                  ["100%", "actions audited"],
                ].map(([v, l]) => (
                  <div key={l}>
                    <p className="font-heading text-3xl font-bold text-[#c3e7ff]">{v}</p>
                    <p className="mono-label mt-1 text-white/70 text-[10px]">{l}</p>
                  </div>
                ))}
          </div>
        </motion.div>

        {/* FORM CONTAINER
            In Sign In: Order 2 (Right on desktop)
            In Sign Up: Order 1 (Left on desktop)
        */}
        <motion.div
          layout
          transition={{ type: "spring", stiffness: 180, damping: 25 }}
          className={cn(
            "relative flex flex-1 flex-col justify-center px-6 py-10 sm:px-12 lg:px-16 bg-background overflow-hidden",
            isSignUp ? "order-1" : "order-2"
          )}
        >
          <BrandDoodles />
          <div className="relative z-10 mx-auto w-full max-w-sm">
            {/* Mobile Header */}
            <div className="mb-8 flex items-center justify-center gap-2.5 lg:hidden">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-slate-900 p-1.5 shadow-xs">
                <img src="/brand/logo.svg" alt="Carbon & Whale" className="h-full w-full object-contain" />
              </div>
              <div>
                <span className="font-heading text-base font-bold text-foreground">Carbon &amp; Whale</span>
                <p className="mono-label text-[9px] text-muted-foreground">IMS · Ad Inventory System</p>
              </div>
            </div>

            <AnimatePresence mode="wait">
              {/* ─────────────────────────────────────────────────────────────
                  MODE: SIGN IN
              ───────────────────────────────────────────────────────────── */}
              {mode === "signin" && (
                <motion.div
                  key="panel-signin"
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 20 }}
                  transition={{ duration: 0.25 }}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <h2 className="font-heading text-2xl font-bold tracking-tight text-foreground">Sign in</h2>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Access your team's operational workspace.
                      </p>
                    </div>
                  </div>

                  <form
                    className="mt-6 space-y-4"
                    onSubmit={(e) => {
                      e.preventDefault();
                      login.mutate({ email, password });
                    }}
                    data-testid="login-form"
                  >
                    <div className="space-y-1.5">
                      <Label htmlFor="email">Work email</Label>
                      <div className="relative">
                        <Input
                          id="email"
                          type="email"
                          required
                          autoComplete="email"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          placeholder="you@company.com"
                          className="pl-9"
                          data-testid="login-email-input"
                        />
                        <Mail className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="password">Password</Label>
                        <button
                          type="button"
                          onClick={() => {
                            sound.click();
                            setMode("forgot");
                          }}
                          className="text-xs font-medium text-primary hover:underline cursor-pointer"
                          data-testid="forgot-password-link"
                        >
                          Forgot password?
                        </button>
                      </div>
                      <div className="relative">
                        <Input
                          id="password"
                          type={showPassword ? "text" : "password"}
                          required
                          autoComplete="current-password"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          placeholder="••••••••"
                          className="pl-9 pr-10"
                          data-testid="login-password-input"
                        />
                        <Lock className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                        <button
                          type="button"
                          onClick={() => setShowPassword(!showPassword)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground focus:outline-none"
                          aria-label={showPassword ? "Hide password" : "Show password"}
                          data-testid="toggle-password-visibility"
                        >
                          {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                        </button>
                      </div>
                    </div>

                    <Button
                      type="submit"
                      className="w-full transition-transform duration-150 active:scale-[0.99]"
                      disabled={login.isPending}
                      data-testid="login-submit-button"
                    >
                      {login.isPending ? "Signing in…" : "Sign in"}
                    </Button>
                  </form>

                  {/* Switch to Sign Up */}
                  <div className="mt-5 text-center text-xs text-muted-foreground">
                    Don't have an account?{" "}
                    <button
                      type="button"
                      onClick={() => {
                        sound.click();
                        setMode("signup");
                        navigate("/signup");
                      }}
                      className="font-semibold text-primary hover:underline cursor-pointer"
                      data-testid="switch-to-signup"
                    >
                      Sign up
                    </button>
                  </div>
                </motion.div>
              )}

              {/* ─────────────────────────────────────────────────────────────
                  MODE: SIGN UP
              ───────────────────────────────────────────────────────────── */}
              {mode === "signup" && (
                <motion.div
                  key="panel-signup"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  transition={{ duration: 0.25 }}
                >
                  <div>
                    <h2 className="font-heading text-2xl font-bold tracking-tight text-foreground">Create account</h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Register to join the Carbon &amp; Whale platform.
                    </p>
                  </div>

                  <form
                    className="mt-6 space-y-3.5"
                    onSubmit={(e) => {
                      e.preventDefault();
                      signup.mutate({
                        name: signupName,
                        email: signupEmail,
                        role: signupRole,
                        password: signupPassword,
                        confirmPassword: signupConfirmPassword,
                      });
                    }}
                    data-testid="signup-form"
                  >
                    <div className="space-y-1.5">
                      <Label htmlFor="signup-name">Full name</Label>
                      <div className="relative">
                        <Input
                          id="signup-name"
                          type="text"
                          required
                          value={signupName}
                          onChange={(e) => setSignupName(e.target.value)}
                          placeholder="Jane Doe"
                          className="pl-9"
                          data-testid="signup-name-input"
                        />
                        <User className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <Label htmlFor="signup-email">Work email</Label>
                      <div className="relative">
                        <Input
                          id="signup-email"
                          type="email"
                          required
                          value={signupEmail}
                          onChange={(e) => {
                            setSignupEmail(e.target.value);
                            checkEmailAuthorization(e.target.value);
                          }}
                          onBlur={(e) => checkEmailAuthorization(e.target.value)}
                          placeholder="name@carbonandwhale.com"
                          className="pl-9"
                          data-testid="signup-email-input"
                        />
                        <Mail className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                      </div>
                      {authStatus?.authorized && (
                        <div className="flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400 animate-in fade-in duration-150">
                          <Check className="size-3 shrink-0" />
                          <span>Pre-authorized: <strong className="font-semibold">{authStatus.name}</strong> ({authStatus.role})</span>
                        </div>
                      )}
                      {authStatus?.authorized === false && signupEmail.includes("@") && (
                        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] font-medium text-amber-700 dark:text-amber-300 animate-in fade-in duration-150">
                          Notice: This email is not on the authorized staff whitelist.
                        </div>
                      )}
                    </div>

                    <div className="space-y-1.5">
                      <Label>Primary role</Label>
                      <Select value={signupRole} onValueChange={setSignupRole}>
                        <SelectTrigger className="w-full" data-testid="signup-role-select">
                          <SelectValue>{(v) => ROLES.find((r) => r.value === v)?.label ?? v}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {ROLES.map((r) => (
                            <SelectItem key={r.value} value={r.value}>
                              {r.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-1.5">
                      <Label htmlFor="signup-password">Password</Label>
                      <div className="relative">
                        <Input
                          id="signup-password"
                          type={showSignupPassword ? "text" : "password"}
                          required
                          value={signupPassword}
                          onChange={(e) => setSignupPassword(e.target.value)}
                          placeholder="Min 6 characters"
                          className="pl-9 pr-10"
                          data-testid="signup-password-input"
                        />
                        <Lock className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                        <button
                          type="button"
                          onClick={() => setShowSignupPassword(!showSignupPassword)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground focus:outline-none"
                          aria-label={showSignupPassword ? "Hide password" : "Show password"}
                          data-testid="toggle-signup-password-visibility"
                        >
                          {showSignupPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                        </button>
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <Label htmlFor="signup-confirm">Confirm password</Label>
                      <div className="relative">
                        <Input
                          id="signup-confirm"
                          type={showConfirmPassword ? "text" : "password"}
                          required
                          value={signupConfirmPassword}
                          onChange={(e) => setSignupConfirmPassword(e.target.value)}
                          placeholder="Re-enter password"
                          className="pl-9 pr-10"
                          data-testid="signup-confirm-input"
                        />
                        <Lock className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                        <button
                          type="button"
                          onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground focus:outline-none"
                          aria-label={showConfirmPassword ? "Hide password" : "Show password"}
                          data-testid="toggle-confirm-password-visibility"
                        >
                          {showConfirmPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                        </button>
                      </div>
                    </div>

                    <Button
                      type="submit"
                      className="w-full mt-2 transition-transform duration-150 active:scale-[0.99]"
                      disabled={signup.isPending}
                      data-testid="signup-submit-button"
                    >
                      {signup.isPending ? "Creating account…" : "Create account"}
                    </Button>
                  </form>

                  {/* Switch back to Sign In */}
                  <div className="mt-5 text-center text-xs text-muted-foreground">
                    Already have an account?{" "}
                    <button
                      type="button"
                      onClick={() => {
                        sound.click();
                        setMode("signin");
                        navigate("/login");
                      }}
                      className="font-semibold text-primary hover:underline cursor-pointer"
                      data-testid="switch-to-signin"
                    >
                      Sign in
                    </button>
                  </div>
                </motion.div>
              )}

              {/* ─────────────────────────────────────────────────────────────
                  MODE: FORGOT PASSWORD
              ───────────────────────────────────────────────────────────── */}
              {mode === "forgot" && (
                <motion.div
                  key="panel-forgot"
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  transition={{ duration: 0.2 }}
                >
                  <button
                    type="button"
                    onClick={() => {
                      sound.click();
                      setMode("signin");
                      setForgotSubmitted(false);
                      if (location.pathname !== "/login") {
                        navigate("/login");
                      }
                    }}
                    className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground mb-4 cursor-pointer"
                  >
                    <ArrowLeft className="size-3.5" />
                    Back to sign in
                  </button>

                  <h2 className="font-heading text-2xl font-bold tracking-tight text-foreground">Reset password</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Enter your work email address and we'll send you instructions to reset your password.
                  </p>

                  {forgotSubmitted ? (
                    <div className="mt-6 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-xs text-[#006d37] shadow-xs">
                      <p className="font-semibold flex items-center gap-1.5">
                        <Check className="size-4" />
                        Instructions Dispatched
                      </p>
                      <p className="mt-1.5 text-emerald-900 leading-relaxed">
                        If an account exists for <span className="font-medium">{forgotEmail}</span>, you will receive password reset instructions shortly.
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="mt-4 w-full border-emerald-300 text-[#006d37] hover:bg-emerald-100"
                        onClick={() => {
                          sound.click();
                          setMode("signin");
                          setForgotSubmitted(false);
                          if (location.pathname !== "/login") {
                            navigate("/login");
                          }
                        }}
                      >
                        Return to sign in
                      </Button>
                    </div>
                  ) : (
                    <form
                      className="mt-6 space-y-4"
                      onSubmit={(e) => {
                        e.preventDefault();
                        forgot.mutate(forgotEmail);
                      }}
                      data-testid="forgot-password-form"
                    >
                      <div className="space-y-1.5">
                        <Label htmlFor="forgot-email">Work email</Label>
                        <div className="relative">
                          <Input
                            id="forgot-email"
                            type="email"
                            required
                            value={forgotEmail}
                            onChange={(e) => setForgotEmail(e.target.value)}
                            placeholder="you@company.com"
                            className="pl-9"
                            data-testid="forgot-email-input"
                          />
                          <Mail className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                        </div>
                      </div>

                      {forgot.isError && (
                        <div className="rounded-xl border border-rose-200 bg-rose-50/80 p-3.5 text-xs text-rose-900 shadow-xs dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-200">
                          <p className="font-semibold text-rose-700 dark:text-rose-400">
                            Unable to send recovery email
                          </p>
                          <p className="mt-1 leading-relaxed">
                            {forgot.error?.message}
                          </p>
                          <p className="mt-2 text-[11px] text-muted-foreground border-t border-rose-200/60 pt-2 dark:border-rose-900/40">
                            Tip: If Supabase Custom SMTP is pending setup, please reach out to your system administrator (<span className="font-medium text-foreground">abirambijoy@gmail.com</span>) to manually reset your access credentials.
                          </p>
                        </div>
                      )}

                      <Button
                        type="submit"
                        className="w-full"
                        disabled={forgot.isPending}
                        data-testid="forgot-submit-button"
                      >
                        {forgot.isPending ? "Sending link…" : "Send reset link"}
                      </Button>
                    </form>
                  )}
                </motion.div>
              )}

              {/* ─────────────────────────────────────────────────────────────
                  MODE: UPDATE / SET NEW PASSWORD
              ───────────────────────────────────────────────────────────── */}
              {mode === "update_password" && (
                <motion.div
                  key="panel-update-password"
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  transition={{ duration: 0.2 }}
                >
                  <h2 className="font-heading text-2xl font-bold tracking-tight text-foreground">Set new password</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Create a secure new password for your account.
                  </p>

                  <form
                    className="mt-6 space-y-4"
                    onSubmit={(e) => {
                      e.preventDefault();
                      updatePassword.mutate({ newPassword, confirmNewPassword });
                    }}
                    data-testid="update-password-form"
                  >
                    <div className="space-y-1.5">
                      <Label htmlFor="new-password">New password</Label>
                      <div className="relative">
                        <Input
                          id="new-password"
                          type={showNewPassword ? "text" : "password"}
                          required
                          value={newPassword}
                          onChange={(e) => setNewPassword(e.target.value)}
                          placeholder="At least 6 characters"
                          className="pl-9 pr-9"
                          data-testid="new-password-input"
                        />
                        <Lock className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                        <button
                          type="button"
                          onClick={() => setShowNewPassword(!showNewPassword)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground cursor-pointer"
                        >
                          {showNewPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                        </button>
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <Label htmlFor="confirm-new-password">Confirm new password</Label>
                      <div className="relative">
                        <Input
                          id="confirm-new-password"
                          type={showConfirmNewPassword ? "text" : "password"}
                          required
                          value={confirmNewPassword}
                          onChange={(e) => setConfirmNewPassword(e.target.value)}
                          placeholder="Re-enter new password"
                          className="pl-9 pr-9"
                          data-testid="confirm-new-password-input"
                        />
                        <Lock className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                        <button
                          type="button"
                          onClick={() => setShowConfirmNewPassword(!showConfirmNewPassword)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground cursor-pointer"
                        >
                          {showConfirmNewPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                        </button>
                      </div>
                    </div>

                    <Button
                      type="submit"
                      className="w-full"
                      disabled={updatePassword.isPending}
                      data-testid="update-password-submit-button"
                    >
                      {updatePassword.isPending ? "Updating password…" : "Save new password & sign in"}
                    </Button>
                  </form>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
