export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.4"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      bodyweight_entries: {
        Row: {
          created_at: string
          date: string
          deleted_at: string | null
          id: string
          updated_at: string
          user_id: string
          weight: number
        }
        Insert: {
          created_at?: string
          date: string
          deleted_at?: string | null
          id?: string
          updated_at?: string
          user_id: string
          weight: number
        }
        Update: {
          created_at?: string
          date?: string
          deleted_at?: string | null
          id?: string
          updated_at?: string
          user_id?: string
          weight?: number
        }
        Relationships: []
      }
      exercises: {
        Row: {
          archived_at: string | null
          bar_weight: number | null
          bodyweight_loaded: boolean
          created_at: string
          deleted_at: string | null
          equipment: string | null
          gyms: string[]
          id: string
          input_mode: string
          intensity_max_reps: number | null
          name: string
          notes: string | null
          plate_count_mode: string | null
          plate_loaded: boolean
          tags: string[]
          updated_at: string
          user_id: string
          warmup_scheme: Json | null
        }
        Insert: {
          archived_at?: string | null
          bar_weight?: number | null
          bodyweight_loaded?: boolean
          created_at?: string
          deleted_at?: string | null
          equipment?: string | null
          gyms?: string[]
          id?: string
          input_mode?: string
          intensity_max_reps?: number | null
          name: string
          notes?: string | null
          plate_count_mode?: string | null
          plate_loaded?: boolean
          tags?: string[]
          updated_at?: string
          user_id: string
          warmup_scheme?: Json | null
        }
        Update: {
          archived_at?: string | null
          bar_weight?: number | null
          bodyweight_loaded?: boolean
          created_at?: string
          deleted_at?: string | null
          equipment?: string | null
          gyms?: string[]
          id?: string
          input_mode?: string
          intensity_max_reps?: number | null
          name?: string
          notes?: string | null
          plate_count_mode?: string | null
          plate_loaded?: boolean
          tags?: string[]
          updated_at?: string
          user_id?: string
          warmup_scheme?: Json | null
        }
        Relationships: []
      }
      progression_snapshots: {
        Row: {
          created_at: string
          id: string
          streak_weeks: number
          themes_unlocked: number
          total_xp: number
          training_days: number
          user_id: string
          week_start: string
          week_xp: number
          weekly_target: number
        }
        Insert: {
          created_at?: string
          id?: string
          streak_weeks?: number
          themes_unlocked?: number
          total_xp: number
          training_days?: number
          user_id: string
          week_start: string
          week_xp?: number
          weekly_target?: number
        }
        Update: {
          created_at?: string
          id?: string
          streak_weeks?: number
          themes_unlocked?: number
          total_xp?: number
          training_days?: number
          user_id?: string
          week_start?: string
          week_xp?: number
          weekly_target?: number
        }
        Relationships: []
      }
      sets: {
        Row: {
          attempted_next_rep: boolean
          created_at: string
          date: string
          deleted_at: string | null
          estimated_1rm: number
          exercise_id: string
          id: string
          note: string | null
          reps: number
          session_id: string | null
          updated_at: string
          user_id: string
          weight: number
        }
        Insert: {
          attempted_next_rep?: boolean
          created_at?: string
          date: string
          deleted_at?: string | null
          estimated_1rm: number
          exercise_id: string
          id?: string
          note?: string | null
          reps: number
          session_id?: string | null
          updated_at?: string
          user_id: string
          weight: number
        }
        Update: {
          attempted_next_rep?: boolean
          created_at?: string
          date?: string
          deleted_at?: string | null
          estimated_1rm?: number
          exercise_id?: string
          id?: string
          note?: string | null
          reps?: number
          session_id?: string | null
          updated_at?: string
          user_id?: string
          weight?: number
        }
        Relationships: [
          {
            foreignKeyName: "sets_exercise_id_fkey"
            columns: ["exercise_id"]
            isOneToOne: false
            referencedRelation: "exercises"
            referencedColumns: ["id"]
          },
        ]
      }
      user_preferences: {
        Row: {
          id: string
          preferences: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          id?: string
          preferences?: Json
          updated_at?: string
          user_id: string
        }
        Update: {
          id?: string
          preferences?: Json
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_progression: {
        Row: {
          bodyweight_xp_dates: Json
          epoch: number
          pending_target_change: number | null
          progression_enabled: boolean
          show_progression: boolean
          starter_confirmed: boolean
          starter_theme: string | null
          streak_history: Json
          streak_weeks: number
          total_xp: number
          unlocked_themes: Json
          updated_at: string
          user_id: string
          weekly_target: number
          xp_per_set: Json
        }
        Insert: {
          bodyweight_xp_dates?: Json
          epoch?: number
          pending_target_change?: number | null
          progression_enabled?: boolean
          show_progression?: boolean
          starter_confirmed?: boolean
          starter_theme?: string | null
          streak_history?: Json
          streak_weeks?: number
          total_xp?: number
          unlocked_themes?: Json
          updated_at?: string
          user_id: string
          weekly_target?: number
          xp_per_set?: Json
        }
        Update: {
          bodyweight_xp_dates?: Json
          epoch?: number
          pending_target_change?: number | null
          progression_enabled?: boolean
          show_progression?: boolean
          starter_confirmed?: boolean
          starter_theme?: string | null
          streak_history?: Json
          streak_weeks?: number
          total_xp?: number
          unlocked_themes?: Json
          updated_at?: string
          user_id?: string
          weekly_target?: number
          xp_per_set?: Json
        }
        Relationships: []
      }
      xp_events: {
        Row: {
          active_theme: string | null
          base_xp: number
          epoch: number
          exercise_id: string | null
          final_xp: number
          id: string
          is_pr: boolean
          is_rep_pr: boolean
          is_tie: boolean
          logged_at: string
          set_date: string | null
          set_id: string
          streak_multiplier: number
          user_id: string
          zone: string
        }
        Insert: {
          active_theme?: string | null
          base_xp: number
          epoch?: number
          exercise_id?: string | null
          final_xp: number
          id?: string
          is_pr?: boolean
          is_rep_pr?: boolean
          is_tie?: boolean
          logged_at?: string
          set_date?: string | null
          set_id: string
          streak_multiplier?: number
          user_id: string
          zone: string
        }
        Update: {
          active_theme?: string | null
          base_xp?: number
          epoch?: number
          exercise_id?: string | null
          final_xp?: number
          id?: string
          is_pr?: boolean
          is_rep_pr?: boolean
          is_tie?: boolean
          logged_at?: string
          set_date?: string | null
          set_id?: string
          streak_multiplier?: number
          user_id?: string
          zone?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      // SECURITY DEFINER purge of the AI-Coach tables (coach_usage,
      // coach_usage_log, coach_consent). Those have RLS on with SELECT-only
      // policies, so the client cannot delete them directly — deleteAccount()
      // calls this instead. It derives the user from auth.uid() internally and
      // takes no arguments. See 20260627000000_add_ai_coach_tables.sql.
      delete_coach_data: {
        Args: Record<PropertyKey, never>
        Returns: undefined
      }
      // SECURITY DEFINER deletion of the caller's own `auth.users` row (#1299).
      // The anon key the browser ships cannot reach `auth.admin`, and
      // `authenticated` has no write access to the auth schema, so this RPC is
      // the client's only path to deleting the account itself (as opposed to
      // its data). It derives the user from auth.uid() internally and takes no
      // arguments. See 20260901000000_add_delete_user_account.sql.
      delete_user_account: {
        Args: Record<PropertyKey, never>
        Returns: undefined
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
