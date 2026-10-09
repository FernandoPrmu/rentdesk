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
    PostgrestVersion: "14.18"
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
      agreement_terms_history: {
        Row: {
          agreement_id: string
          bw_included: number
          bw_rate_cents: number
          changed_at: string
          changed_by: string | null
          colour_included: number | null
          colour_rate_cents: number | null
          due_days: number
          effective_from_cycle_no: number
          id: string
          late_fee_cents: number | null
          late_fee_mode: Database["public"]["Enums"]["late_fee_mode"]
          monthly_commitment_cents: number
          note: string | null
          owner_id: string
          version: number
        }
        Insert: {
          agreement_id: string
          bw_included: number
          bw_rate_cents: number
          changed_at?: string
          changed_by?: string | null
          colour_included?: number | null
          colour_rate_cents?: number | null
          due_days: number
          effective_from_cycle_no: number
          id?: string
          late_fee_cents?: number | null
          late_fee_mode?: Database["public"]["Enums"]["late_fee_mode"]
          monthly_commitment_cents: number
          note?: string | null
          owner_id: string
          version: number
        }
        Update: {
          agreement_id?: string
          bw_included?: number
          bw_rate_cents?: number
          changed_at?: string
          changed_by?: string | null
          colour_included?: number | null
          colour_rate_cents?: number | null
          due_days?: number
          effective_from_cycle_no?: number
          id?: string
          late_fee_cents?: number | null
          late_fee_mode?: Database["public"]["Enums"]["late_fee_mode"]
          monthly_commitment_cents?: number
          note?: string | null
          owner_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "agreement_terms_history_agreement_fkey"
            columns: ["agreement_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "rental_agreements"
            referencedColumns: ["id", "owner_id"]
          },
          {
            foreignKeyName: "agreement_terms_history_changed_by_fkey"
            columns: ["changed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agreement_terms_history_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owner_settings_effective"
            referencedColumns: ["owner_id"]
          },
          {
            foreignKeyName: "agreement_terms_history_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owners"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          actor_id: string | null
          actor_role: Database["public"]["Enums"]["user_role"] | null
          created_at: string
          details: Json
          entity: string
          entity_id: string | null
          id: number
          owner_id: string | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          actor_role?: Database["public"]["Enums"]["user_role"] | null
          created_at?: string
          details?: Json
          entity: string
          entity_id?: string | null
          id?: never
          owner_id?: string | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          actor_role?: Database["public"]["Enums"]["user_role"] | null
          created_at?: string
          details?: Json
          entity?: string
          entity_id?: string | null
          id?: never
          owner_id?: string | null
        }
        Relationships: []
      }
      billing_cycle_tickets: {
        Row: {
          agreement_id: string
          bw_included: number
          bw_rate_cents: number
          closed_at: string | null
          closed_by: string | null
          colour_included: number | null
          colour_rate_cents: number | null
          commitment_cents: number
          created_at: string
          current_invoice_id: string | null
          customer_id: string
          cycle_date: string
          cycle_length_days: number
          cycle_no: number
          due_days: number | null
          escalation_level: number
          id: string
          is_late: boolean
          last_reminder_at: string | null
          late_fee_cents: number | null
          late_fee_mode: Database["public"]["Enums"]["late_fee_mode"]
          machine_id: string
          machine_type: Database["public"]["Enums"]["machine_type"]
          owner_id: string
          paused_at: string | null
          period_end: string
          period_start: string
          rejection_count: number
          reminder_count: number
          stage_due_at: string | null
          status: Database["public"]["Enums"]["ticket_status"]
          status_before_overdue:
            | Database["public"]["Enums"]["ticket_status"]
            | null
          updated_at: string
        }
        Insert: {
          agreement_id: string
          bw_included: number
          bw_rate_cents: number
          closed_at?: string | null
          closed_by?: string | null
          colour_included?: number | null
          colour_rate_cents?: number | null
          commitment_cents: number
          created_at?: string
          current_invoice_id?: string | null
          customer_id: string
          cycle_date: string
          cycle_length_days: number
          cycle_no: number
          due_days?: number | null
          escalation_level?: number
          id?: string
          is_late?: boolean
          last_reminder_at?: string | null
          late_fee_cents?: number | null
          late_fee_mode?: Database["public"]["Enums"]["late_fee_mode"]
          machine_id: string
          machine_type: Database["public"]["Enums"]["machine_type"]
          owner_id: string
          paused_at?: string | null
          period_end: string
          period_start: string
          rejection_count?: number
          reminder_count?: number
          stage_due_at?: string | null
          status?: Database["public"]["Enums"]["ticket_status"]
          status_before_overdue?:
            | Database["public"]["Enums"]["ticket_status"]
            | null
          updated_at?: string
        }
        Update: {
          agreement_id?: string
          bw_included?: number
          bw_rate_cents?: number
          closed_at?: string | null
          closed_by?: string | null
          colour_included?: number | null
          colour_rate_cents?: number | null
          commitment_cents?: number
          created_at?: string
          current_invoice_id?: string | null
          customer_id?: string
          cycle_date?: string
          cycle_length_days?: number
          cycle_no?: number
          due_days?: number | null
          escalation_level?: number
          id?: string
          is_late?: boolean
          last_reminder_at?: string | null
          late_fee_cents?: number | null
          late_fee_mode?: Database["public"]["Enums"]["late_fee_mode"]
          machine_id?: string
          machine_type?: Database["public"]["Enums"]["machine_type"]
          owner_id?: string
          paused_at?: string | null
          period_end?: string
          period_start?: string
          rejection_count?: number
          reminder_count?: number
          stage_due_at?: string | null
          status?: Database["public"]["Enums"]["ticket_status"]
          status_before_overdue?:
            | Database["public"]["Enums"]["ticket_status"]
            | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_cycle_tickets_agreement_fkey"
            columns: ["agreement_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "rental_agreements"
            referencedColumns: ["id", "owner_id"]
          },
          {
            foreignKeyName: "billing_cycle_tickets_closed_by_fkey"
            columns: ["closed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_cycle_tickets_current_invoice_fkey"
            columns: ["current_invoice_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id", "owner_id"]
          },
          {
            foreignKeyName: "billing_cycle_tickets_customer_fkey"
            columns: ["customer_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id", "owner_id"]
          },
          {
            foreignKeyName: "billing_cycle_tickets_machine_fkey"
            columns: ["machine_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "machines"
            referencedColumns: ["id", "owner_id"]
          },
          {
            foreignKeyName: "billing_cycle_tickets_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owner_settings_effective"
            referencedColumns: ["owner_id"]
          },
          {
            foreignKeyName: "billing_cycle_tickets_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owners"
            referencedColumns: ["id"]
          },
        ]
      }
      credits: {
        Row: {
          agreement_id: string | null
          amount_cents: number
          applied_at: string | null
          applied_to_invoice_id: string | null
          created_at: string
          created_by: string | null
          customer_id: string
          id: string
          kind: Database["public"]["Enums"]["credit_kind"]
          method: Database["public"]["Enums"]["payment_method"] | null
          owner_id: string
          reason: string
          received_on: string | null
          reference: string | null
          refunded_at: string | null
          source_invoice_id: string | null
          source_payment_id: string | null
          status: Database["public"]["Enums"]["credit_status"]
          updated_at: string
        }
        Insert: {
          agreement_id?: string | null
          amount_cents: number
          applied_at?: string | null
          applied_to_invoice_id?: string | null
          created_at?: string
          created_by?: string | null
          customer_id: string
          id?: string
          kind: Database["public"]["Enums"]["credit_kind"]
          method?: Database["public"]["Enums"]["payment_method"] | null
          owner_id: string
          reason: string
          received_on?: string | null
          reference?: string | null
          refunded_at?: string | null
          source_invoice_id?: string | null
          source_payment_id?: string | null
          status?: Database["public"]["Enums"]["credit_status"]
          updated_at?: string
        }
        Update: {
          agreement_id?: string | null
          amount_cents?: number
          applied_at?: string | null
          applied_to_invoice_id?: string | null
          created_at?: string
          created_by?: string | null
          customer_id?: string
          id?: string
          kind?: Database["public"]["Enums"]["credit_kind"]
          method?: Database["public"]["Enums"]["payment_method"] | null
          owner_id?: string
          reason?: string
          received_on?: string | null
          reference?: string | null
          refunded_at?: string | null
          source_invoice_id?: string | null
          source_payment_id?: string | null
          status?: Database["public"]["Enums"]["credit_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "credits_agreement_fkey"
            columns: ["agreement_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "rental_agreements"
            referencedColumns: ["id", "owner_id"]
          },
          {
            foreignKeyName: "credits_applied_to_fkey"
            columns: ["applied_to_invoice_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id", "owner_id"]
          },
          {
            foreignKeyName: "credits_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "credits_customer_fkey"
            columns: ["customer_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id", "owner_id"]
          },
          {
            foreignKeyName: "credits_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owner_settings_effective"
            referencedColumns: ["owner_id"]
          },
          {
            foreignKeyName: "credits_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owners"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "credits_source_invoice_fkey"
            columns: ["source_invoice_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id", "owner_id"]
          },
          {
            foreignKeyName: "credits_source_payment_fkey"
            columns: ["source_payment_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id", "owner_id"]
          },
        ]
      }
      customers: {
        Row: {
          address: string | null
          business_name: string | null
          created_at: string
          email: string | null
          id: string
          name: string
          owner_id: string
          phone: string | null
          updated_at: string
        }
        Insert: {
          address?: string | null
          business_name?: string | null
          created_at?: string
          email?: string | null
          id: string
          name: string
          owner_id: string
          phone?: string | null
          updated_at?: string
        }
        Update: {
          address?: string | null
          business_name?: string | null
          created_at?: string
          email?: string | null
          id?: string
          name?: string
          owner_id?: string
          phone?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "customers_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owner_settings_effective"
            referencedColumns: ["owner_id"]
          },
          {
            foreignKeyName: "customers_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owners"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customers_profile_fkey"
            columns: ["id", "owner_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id", "owner_id"]
          },
        ]
      }
      deposit_transactions: {
        Row: {
          agreement_id: string
          amount_cents: number
          created_at: string
          created_by: string | null
          customer_id: string
          id: string
          invoice_id: string | null
          kind: Database["public"]["Enums"]["deposit_transaction_kind"]
          method: Database["public"]["Enums"]["payment_method"] | null
          note: string | null
          occurred_on: string
          owner_id: string
          payment_id: string | null
          reference: string | null
        }
        Insert: {
          agreement_id: string
          amount_cents: number
          created_at?: string
          created_by?: string | null
          customer_id: string
          id?: string
          invoice_id?: string | null
          kind: Database["public"]["Enums"]["deposit_transaction_kind"]
          method?: Database["public"]["Enums"]["payment_method"] | null
          note?: string | null
          occurred_on: string
          owner_id: string
          payment_id?: string | null
          reference?: string | null
        }
        Update: {
          agreement_id?: string
          amount_cents?: number
          created_at?: string
          created_by?: string | null
          customer_id?: string
          id?: string
          invoice_id?: string | null
          kind?: Database["public"]["Enums"]["deposit_transaction_kind"]
          method?: Database["public"]["Enums"]["payment_method"] | null
          note?: string | null
          occurred_on?: string
          owner_id?: string
          payment_id?: string | null
          reference?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "deposit_transactions_agreement_fkey"
            columns: ["agreement_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "rental_agreements"
            referencedColumns: ["id", "owner_id"]
          },
          {
            foreignKeyName: "deposit_transactions_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deposit_transactions_customer_fkey"
            columns: ["customer_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id", "owner_id"]
          },
          {
            foreignKeyName: "deposit_transactions_invoice_fkey"
            columns: ["invoice_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id", "owner_id"]
          },
          {
            foreignKeyName: "deposit_transactions_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owner_settings_effective"
            referencedColumns: ["owner_id"]
          },
          {
            foreignKeyName: "deposit_transactions_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owners"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deposit_transactions_payment_fkey"
            columns: ["payment_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id", "owner_id"]
          },
        ]
      }
      disputes: {
        Row: {
          created_at: string
          customer_id: string
          id: string
          invoice_id: string
          owner_id: string
          raised_by: string
          reason: string
          resolution: string | null
          resolved_at: string | null
          resolved_by: string | null
          status: Database["public"]["Enums"]["dispute_status"]
          ticket_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          customer_id: string
          id?: string
          invoice_id: string
          owner_id: string
          raised_by: string
          reason: string
          resolution?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: Database["public"]["Enums"]["dispute_status"]
          ticket_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          customer_id?: string
          id?: string
          invoice_id?: string
          owner_id?: string
          raised_by?: string
          reason?: string
          resolution?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: Database["public"]["Enums"]["dispute_status"]
          ticket_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "disputes_customer_fkey"
            columns: ["customer_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id", "owner_id"]
          },
          {
            foreignKeyName: "disputes_invoice_fkey"
            columns: ["invoice_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id", "owner_id"]
          },
          {
            foreignKeyName: "disputes_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owner_settings_effective"
            referencedColumns: ["owner_id"]
          },
          {
            foreignKeyName: "disputes_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owners"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "disputes_raised_by_fkey"
            columns: ["raised_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "disputes_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "disputes_ticket_fkey"
            columns: ["ticket_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "billing_cycle_tickets"
            referencedColumns: ["id", "owner_id"]
          },
        ]
      }
      idempotency_keys: {
        Row: {
          created_at: string
          expires_at: string
          key: string
          owner_id: string | null
          request_hash: string
          response: Json | null
          scope: Database["public"]["Enums"]["idempotency_scope"]
          status: string
          user_id: string
        }
        Insert: {
          created_at?: string
          expires_at?: string
          key: string
          owner_id?: string | null
          request_hash: string
          response?: Json | null
          scope: Database["public"]["Enums"]["idempotency_scope"]
          status?: string
          user_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          key?: string
          owner_id?: string | null
          request_hash?: string
          response?: Json | null
          scope?: Database["public"]["Enums"]["idempotency_scope"]
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "idempotency_keys_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owner_settings_effective"
            referencedColumns: ["owner_id"]
          },
          {
            foreignKeyName: "idempotency_keys_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owners"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "idempotency_keys_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_counters: {
        Row: {
          last_value: number
          owner_id: string
          prefix: string
          updated_at: string
        }
        Insert: {
          last_value?: number
          owner_id: string
          prefix?: string
          updated_at?: string
        }
        Update: {
          last_value?: number
          owner_id?: string
          prefix?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "invoice_counters_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: true
            referencedRelation: "owner_settings_effective"
            referencedColumns: ["owner_id"]
          },
          {
            foreignKeyName: "invoice_counters_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: true
            referencedRelation: "owners"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_lines: {
        Row: {
          amount_cents: number
          created_at: string
          credit_id: string | null
          description: string
          id: string
          invoice_id: string
          line_type: Database["public"]["Enums"]["invoice_line_type"]
          owner_id: string
          quantity: number
          rate_cents: number
          sort_order: number
        }
        Insert: {
          amount_cents: number
          created_at?: string
          credit_id?: string | null
          description: string
          id?: string
          invoice_id: string
          line_type: Database["public"]["Enums"]["invoice_line_type"]
          owner_id: string
          quantity?: number
          rate_cents: number
          sort_order?: number
        }
        Update: {
          amount_cents?: number
          created_at?: string
          credit_id?: string | null
          description?: string
          id?: string
          invoice_id?: string
          line_type?: Database["public"]["Enums"]["invoice_line_type"]
          owner_id?: string
          quantity?: number
          rate_cents?: number
          sort_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "invoice_lines_credit_fkey"
            columns: ["credit_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "credits"
            referencedColumns: ["id", "owner_id"]
          },
          {
            foreignKeyName: "invoice_lines_invoice_fkey"
            columns: ["invoice_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id", "owner_id"]
          },
          {
            foreignKeyName: "invoice_lines_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owner_settings_effective"
            referencedColumns: ["owner_id"]
          },
          {
            foreignKeyName: "invoice_lines_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owners"
            referencedColumns: ["id"]
          },
        ]
      }
      invoices: {
        Row: {
          agreement_id: string
          amount_paid_cents: number
          branding_snapshot: Json | null
          calculation: Json | null
          cancel_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          confirmed_at: string | null
          confirmed_by: string | null
          created_at: string
          credit_applied_cents: number
          customer_id: string
          cycles_covered: number
          due_date: string | null
          id: string
          invoice_no: string | null
          invoice_seq: number | null
          issued_at: string | null
          late_fee_cents: number
          machine_id: string
          owner_id: string
          pdf_path: string | null
          period_end: string
          period_start: string
          replaces_invoice_id: string | null
          status: Database["public"]["Enums"]["invoice_status"]
          subtotal_cents: number
          ticket_id: string
          total_cents: number
          type: Database["public"]["Enums"]["invoice_type"]
          updated_at: string
        }
        Insert: {
          agreement_id: string
          amount_paid_cents?: number
          branding_snapshot?: Json | null
          calculation?: Json | null
          cancel_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          confirmed_at?: string | null
          confirmed_by?: string | null
          created_at?: string
          credit_applied_cents?: number
          customer_id: string
          cycles_covered?: number
          due_date?: string | null
          id?: string
          invoice_no?: string | null
          invoice_seq?: number | null
          issued_at?: string | null
          late_fee_cents?: number
          machine_id: string
          owner_id: string
          pdf_path?: string | null
          period_end: string
          period_start: string
          replaces_invoice_id?: string | null
          status?: Database["public"]["Enums"]["invoice_status"]
          subtotal_cents: number
          ticket_id: string
          total_cents: number
          type?: Database["public"]["Enums"]["invoice_type"]
          updated_at?: string
        }
        Update: {
          agreement_id?: string
          amount_paid_cents?: number
          branding_snapshot?: Json | null
          calculation?: Json | null
          cancel_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          confirmed_at?: string | null
          confirmed_by?: string | null
          created_at?: string
          credit_applied_cents?: number
          customer_id?: string
          cycles_covered?: number
          due_date?: string | null
          id?: string
          invoice_no?: string | null
          invoice_seq?: number | null
          issued_at?: string | null
          late_fee_cents?: number
          machine_id?: string
          owner_id?: string
          pdf_path?: string | null
          period_end?: string
          period_start?: string
          replaces_invoice_id?: string | null
          status?: Database["public"]["Enums"]["invoice_status"]
          subtotal_cents?: number
          ticket_id?: string
          total_cents?: number
          type?: Database["public"]["Enums"]["invoice_type"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "invoices_agreement_fkey"
            columns: ["agreement_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "rental_agreements"
            referencedColumns: ["id", "owner_id"]
          },
          {
            foreignKeyName: "invoices_cancelled_by_fkey"
            columns: ["cancelled_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_confirmed_by_fkey"
            columns: ["confirmed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_customer_fkey"
            columns: ["customer_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id", "owner_id"]
          },
          {
            foreignKeyName: "invoices_machine_fkey"
            columns: ["machine_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "machines"
            referencedColumns: ["id", "owner_id"]
          },
          {
            foreignKeyName: "invoices_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owner_settings_effective"
            referencedColumns: ["owner_id"]
          },
          {
            foreignKeyName: "invoices_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owners"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_replaces_fkey"
            columns: ["replaces_invoice_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id", "owner_id"]
          },
          {
            foreignKeyName: "invoices_ticket_fkey"
            columns: ["ticket_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "billing_cycle_tickets"
            referencedColumns: ["id", "owner_id"]
          },
        ]
      }
      login_attempts: {
        Row: {
          created_at: string
          id: number
          ip: unknown
          reason: string | null
          success: boolean
          user_id: string | null
          username: string
        }
        Insert: {
          created_at?: string
          id?: never
          ip?: unknown
          reason?: string | null
          success: boolean
          user_id?: string | null
          username: string
        }
        Update: {
          created_at?: string
          id?: never
          ip?: unknown
          reason?: string | null
          success?: boolean
          user_id?: string | null
          username?: string
        }
        Relationships: [
          {
            foreignKeyName: "login_attempts_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      machines: {
        Row: {
          brand: string
          bw_counter_max: number | null
          colour_counter_max: number | null
          created_at: string
          id: string
          model: string
          notes: string | null
          owner_id: string
          purchase_date: string | null
          serial_no: string
          status: Database["public"]["Enums"]["machine_status"]
          type: Database["public"]["Enums"]["machine_type"]
          updated_at: string
        }
        Insert: {
          brand: string
          bw_counter_max?: number | null
          colour_counter_max?: number | null
          created_at?: string
          id?: string
          model: string
          notes?: string | null
          owner_id: string
          purchase_date?: string | null
          serial_no: string
          status?: Database["public"]["Enums"]["machine_status"]
          type: Database["public"]["Enums"]["machine_type"]
          updated_at?: string
        }
        Update: {
          brand?: string
          bw_counter_max?: number | null
          colour_counter_max?: number | null
          created_at?: string
          id?: string
          model?: string
          notes?: string | null
          owner_id?: string
          purchase_date?: string | null
          serial_no?: string
          status?: Database["public"]["Enums"]["machine_status"]
          type?: Database["public"]["Enums"]["machine_type"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "machines_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owner_settings_effective"
            referencedColumns: ["owner_id"]
          },
          {
            foreignKeyName: "machines_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owners"
            referencedColumns: ["id"]
          },
        ]
      }
      meter_baselines: {
        Row: {
          agreement_id: string
          counter_type: Database["public"]["Enums"]["counter_type"]
          id: string
          owner_id: string
          reason: string
          recorded_at: string
          recorded_by: string
          value: number
        }
        Insert: {
          agreement_id: string
          counter_type: Database["public"]["Enums"]["counter_type"]
          id?: string
          owner_id: string
          reason: string
          recorded_at?: string
          recorded_by?: string
          value: number
        }
        Update: {
          agreement_id?: string
          counter_type?: Database["public"]["Enums"]["counter_type"]
          id?: string
          owner_id?: string
          reason?: string
          recorded_at?: string
          recorded_by?: string
          value?: number
        }
        Relationships: [
          {
            foreignKeyName: "meter_baselines_agreement_fkey"
            columns: ["agreement_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "rental_agreements"
            referencedColumns: ["id", "owner_id"]
          },
          {
            foreignKeyName: "meter_baselines_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owner_settings_effective"
            referencedColumns: ["owner_id"]
          },
          {
            foreignKeyName: "meter_baselines_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owners"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meter_baselines_recorded_by_fkey"
            columns: ["recorded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      meter_photos: {
        Row: {
          captured_at: string | null
          created_at: string
          delete_requested_at: string | null
          deleted_at: string | null
          expires_at: string | null
          id: string
          owner_id: string
          storage_path: string
          submission_id: string
          uploaded_at: string
        }
        Insert: {
          captured_at?: string | null
          created_at?: string
          delete_requested_at?: string | null
          deleted_at?: string | null
          expires_at?: string | null
          id?: string
          owner_id: string
          storage_path: string
          submission_id: string
          uploaded_at?: string
        }
        Update: {
          captured_at?: string | null
          created_at?: string
          delete_requested_at?: string | null
          deleted_at?: string | null
          expires_at?: string | null
          id?: string
          owner_id?: string
          storage_path?: string
          submission_id?: string
          uploaded_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "meter_photos_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owner_settings_effective"
            referencedColumns: ["owner_id"]
          },
          {
            foreignKeyName: "meter_photos_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owners"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meter_photos_submission_fkey"
            columns: ["submission_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "meter_submissions"
            referencedColumns: ["id", "owner_id"]
          },
        ]
      }
      meter_readings: {
        Row: {
          corrected_at: string | null
          corrected_by: string | null
          corrected_from_value: number | null
          correction_note: string | null
          counter_type: Database["public"]["Enums"]["counter_type"]
          created_at: string
          current_value: number
          id: string
          owner_id: string
          previous_value: number
          rolled_over: boolean
          rollover_confirmed_at: string | null
          rollover_confirmed_by: string | null
          submission_id: string
        }
        Insert: {
          corrected_at?: string | null
          corrected_by?: string | null
          corrected_from_value?: number | null
          correction_note?: string | null
          counter_type: Database["public"]["Enums"]["counter_type"]
          created_at?: string
          current_value: number
          id?: string
          owner_id: string
          previous_value: number
          rolled_over?: boolean
          rollover_confirmed_at?: string | null
          rollover_confirmed_by?: string | null
          submission_id: string
        }
        Update: {
          corrected_at?: string | null
          corrected_by?: string | null
          corrected_from_value?: number | null
          correction_note?: string | null
          counter_type?: Database["public"]["Enums"]["counter_type"]
          created_at?: string
          current_value?: number
          id?: string
          owner_id?: string
          previous_value?: number
          rolled_over?: boolean
          rollover_confirmed_at?: string | null
          rollover_confirmed_by?: string | null
          submission_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "meter_readings_corrected_by_fkey"
            columns: ["corrected_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meter_readings_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owner_settings_effective"
            referencedColumns: ["owner_id"]
          },
          {
            foreignKeyName: "meter_readings_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owners"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meter_readings_rollover_confirmed_by_fkey"
            columns: ["rollover_confirmed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meter_readings_submission_fkey"
            columns: ["submission_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "meter_submissions"
            referencedColumns: ["id", "owner_id"]
          },
        ]
      }
      meter_submissions: {
        Row: {
          anomaly_flag: string | null
          attempt_no: number
          created_at: string
          customer_id: string
          id: string
          idempotency_key: string
          invoice_id: string | null
          note: string | null
          owner_id: string
          reject_reason: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          source: Database["public"]["Enums"]["reading_source"]
          status: Database["public"]["Enums"]["meter_submission_status"]
          submitted_at: string
          submitted_by: string
          ticket_id: string
        }
        Insert: {
          anomaly_flag?: string | null
          attempt_no: number
          created_at?: string
          customer_id: string
          id?: string
          idempotency_key: string
          invoice_id?: string | null
          note?: string | null
          owner_id: string
          reject_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          source: Database["public"]["Enums"]["reading_source"]
          status?: Database["public"]["Enums"]["meter_submission_status"]
          submitted_at?: string
          submitted_by: string
          ticket_id: string
        }
        Update: {
          anomaly_flag?: string | null
          attempt_no?: number
          created_at?: string
          customer_id?: string
          id?: string
          idempotency_key?: string
          invoice_id?: string | null
          note?: string | null
          owner_id?: string
          reject_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          source?: Database["public"]["Enums"]["reading_source"]
          status?: Database["public"]["Enums"]["meter_submission_status"]
          submitted_at?: string
          submitted_by?: string
          ticket_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "meter_submissions_customer_fkey"
            columns: ["customer_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id", "owner_id"]
          },
          {
            foreignKeyName: "meter_submissions_invoice_fkey"
            columns: ["invoice_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id", "owner_id"]
          },
          {
            foreignKeyName: "meter_submissions_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owner_settings_effective"
            referencedColumns: ["owner_id"]
          },
          {
            foreignKeyName: "meter_submissions_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owners"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meter_submissions_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meter_submissions_submitted_by_fkey"
            columns: ["submitted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meter_submissions_ticket_fkey"
            columns: ["ticket_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "billing_cycle_tickets"
            referencedColumns: ["id", "owner_id"]
          },
        ]
      }
      notification_templates: {
        Row: {
          body: string
          channel: Database["public"]["Enums"]["notification_channel"]
          created_at: string
          event: string
          id: string
          locale: string
          owner_id: string | null
          subject: string
          updated_at: string
        }
        Insert: {
          body: string
          channel: Database["public"]["Enums"]["notification_channel"]
          created_at?: string
          event: string
          id?: string
          locale?: string
          owner_id?: string | null
          subject?: string
          updated_at?: string
        }
        Update: {
          body?: string
          channel?: Database["public"]["Enums"]["notification_channel"]
          created_at?: string
          event?: string
          id?: string
          locale?: string
          owner_id?: string | null
          subject?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_templates_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owner_settings_effective"
            referencedColumns: ["owner_id"]
          },
          {
            foreignKeyName: "notification_templates_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owners"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          attempts: number
          body: string
          channel: Database["public"]["Enums"]["notification_channel"]
          created_at: string
          data: Json
          entity_id: string | null
          entity_type: string | null
          event: string
          id: string
          last_error: string | null
          link: string | null
          owner_id: string | null
          read_at: string | null
          sent_at: string | null
          status: Database["public"]["Enums"]["notification_status"]
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          attempts?: number
          body?: string
          channel?: Database["public"]["Enums"]["notification_channel"]
          created_at?: string
          data?: Json
          entity_id?: string | null
          entity_type?: string | null
          event: string
          id?: string
          last_error?: string | null
          link?: string | null
          owner_id?: string | null
          read_at?: string | null
          sent_at?: string | null
          status?: Database["public"]["Enums"]["notification_status"]
          title: string
          updated_at?: string
          user_id: string
        }
        Update: {
          attempts?: number
          body?: string
          channel?: Database["public"]["Enums"]["notification_channel"]
          created_at?: string
          data?: Json
          entity_id?: string | null
          entity_type?: string | null
          event?: string
          id?: string
          last_error?: string | null
          link?: string | null
          owner_id?: string | null
          read_at?: string | null
          sent_at?: string | null
          status?: Database["public"]["Enums"]["notification_status"]
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owner_settings_effective"
            referencedColumns: ["owner_id"]
          },
          {
            foreignKeyName: "notifications_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owners"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      owner_company_profiles: {
        Row: {
          address: string | null
          bank_account_name: string | null
          bank_account_no: string | null
          bank_branch: string | null
          bank_name: string | null
          company_name: string
          created_at: string
          email: string | null
          letterhead_layout: Json
          letterhead_path: string | null
          logo_path: string | null
          onboarding_completed_at: string | null
          owner_id: string
          phone: string | null
          updated_at: string
        }
        Insert: {
          address?: string | null
          bank_account_name?: string | null
          bank_account_no?: string | null
          bank_branch?: string | null
          bank_name?: string | null
          company_name: string
          created_at?: string
          email?: string | null
          letterhead_layout?: Json
          letterhead_path?: string | null
          logo_path?: string | null
          onboarding_completed_at?: string | null
          owner_id: string
          phone?: string | null
          updated_at?: string
        }
        Update: {
          address?: string | null
          bank_account_name?: string | null
          bank_account_no?: string | null
          bank_branch?: string | null
          bank_name?: string | null
          company_name?: string
          created_at?: string
          email?: string | null
          letterhead_layout?: Json
          letterhead_path?: string | null
          logo_path?: string | null
          onboarding_completed_at?: string | null
          owner_id?: string
          phone?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "owner_company_profiles_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: true
            referencedRelation: "owner_settings_effective"
            referencedColumns: ["owner_id"]
          },
          {
            foreignKeyName: "owner_company_profiles_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: true
            referencedRelation: "owners"
            referencedColumns: ["id"]
          },
        ]
      }
      owner_settings: {
        Row: {
          created_at: string
          estimated_billing_enabled: boolean | null
          grace_period_days: number | null
          late_fee_cents: number | null
          late_fee_enabled: boolean | null
          max_meter_rejections: number | null
          meter_deadline_days: number | null
          meter_reminder_days: number[] | null
          owner_id: string
          payment_due_days: number | null
          payment_overdue_reminder_days: number[] | null
          payment_reminder_before_days: number[] | null
          payment_reminder_on_due: boolean | null
          payment_slip_retention_days: number | null
          rejected_photo_retention_days: number | null
          review_deadline_hours: number | null
          review_escalation_hours: number | null
          review_reminder_hours: number[] | null
          service_ack_hours_normal: number | null
          service_ack_hours_urgent: number | null
          service_admin_escalation_hours_normal: number | null
          service_admin_escalation_hours_urgent: number | null
          slip_review_deadline_hours: number | null
          slip_review_escalation_hours: number | null
          slip_review_reminder_hours: number[] | null
          updated_at: string
          weekly_summary_dow: number | null
        }
        Insert: {
          created_at?: string
          estimated_billing_enabled?: boolean | null
          grace_period_days?: number | null
          late_fee_cents?: number | null
          late_fee_enabled?: boolean | null
          max_meter_rejections?: number | null
          meter_deadline_days?: number | null
          meter_reminder_days?: number[] | null
          owner_id: string
          payment_due_days?: number | null
          payment_overdue_reminder_days?: number[] | null
          payment_reminder_before_days?: number[] | null
          payment_reminder_on_due?: boolean | null
          payment_slip_retention_days?: number | null
          rejected_photo_retention_days?: number | null
          review_deadline_hours?: number | null
          review_escalation_hours?: number | null
          review_reminder_hours?: number[] | null
          service_ack_hours_normal?: number | null
          service_ack_hours_urgent?: number | null
          service_admin_escalation_hours_normal?: number | null
          service_admin_escalation_hours_urgent?: number | null
          slip_review_deadline_hours?: number | null
          slip_review_escalation_hours?: number | null
          slip_review_reminder_hours?: number[] | null
          updated_at?: string
          weekly_summary_dow?: number | null
        }
        Update: {
          created_at?: string
          estimated_billing_enabled?: boolean | null
          grace_period_days?: number | null
          late_fee_cents?: number | null
          late_fee_enabled?: boolean | null
          max_meter_rejections?: number | null
          meter_deadline_days?: number | null
          meter_reminder_days?: number[] | null
          owner_id?: string
          payment_due_days?: number | null
          payment_overdue_reminder_days?: number[] | null
          payment_reminder_before_days?: number[] | null
          payment_reminder_on_due?: boolean | null
          payment_slip_retention_days?: number | null
          rejected_photo_retention_days?: number | null
          review_deadline_hours?: number | null
          review_escalation_hours?: number | null
          review_reminder_hours?: number[] | null
          service_ack_hours_normal?: number | null
          service_ack_hours_urgent?: number | null
          service_admin_escalation_hours_normal?: number | null
          service_admin_escalation_hours_urgent?: number | null
          slip_review_deadline_hours?: number | null
          slip_review_escalation_hours?: number | null
          slip_review_reminder_hours?: number[] | null
          updated_at?: string
          weekly_summary_dow?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "owner_settings_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: true
            referencedRelation: "owner_settings_effective"
            referencedColumns: ["owner_id"]
          },
          {
            foreignKeyName: "owner_settings_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: true
            referencedRelation: "owners"
            referencedColumns: ["id"]
          },
        ]
      }
      owners: {
        Row: {
          address: string | null
          business_name: string
          contact_person: string
          created_at: string
          email: string | null
          id: string
          phone: string | null
          plan_id: string | null
          updated_at: string
        }
        Insert: {
          address?: string | null
          business_name: string
          contact_person?: string
          created_at?: string
          email?: string | null
          id: string
          phone?: string | null
          plan_id?: string | null
          updated_at?: string
        }
        Update: {
          address?: string | null
          business_name?: string
          contact_person?: string
          created_at?: string
          email?: string | null
          id?: string
          phone?: string | null
          plan_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "owners_id_fkey"
            columns: ["id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "owners_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "subscription_plans"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_slips: {
        Row: {
          created_at: string
          id: string
          mime_type: string
          owner_id: string
          payment_id: string
          retention_until: string | null
          sha256: string
          size_bytes: number
          storage_path: string
          uploaded_at: string
          uploaded_by: string
        }
        Insert: {
          created_at?: string
          id?: string
          mime_type: string
          owner_id: string
          payment_id: string
          retention_until?: string | null
          sha256: string
          size_bytes: number
          storage_path: string
          uploaded_at?: string
          uploaded_by: string
        }
        Update: {
          created_at?: string
          id?: string
          mime_type?: string
          owner_id?: string
          payment_id?: string
          retention_until?: string | null
          sha256?: string
          size_bytes?: number
          storage_path?: string
          uploaded_at?: string
          uploaded_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_slips_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owner_settings_effective"
            referencedColumns: ["owner_id"]
          },
          {
            foreignKeyName: "payment_slips_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owners"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_slips_payment_fkey"
            columns: ["payment_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id", "owner_id"]
          },
          {
            foreignKeyName: "payment_slips_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      payments: {
        Row: {
          accepted_amount_cents: number | null
          amount_cents: number
          created_at: string
          customer_id: string
          duplicate_of_payment_id: string | null
          id: string
          idempotency_key: string | null
          invoice_id: string
          method: Database["public"]["Enums"]["payment_method"]
          note: string | null
          owner_id: string
          paid_on: string
          reference: string | null
          reject_reason: string | null
          source: Database["public"]["Enums"]["payment_source"]
          status: Database["public"]["Enums"]["payment_status"]
          submitted_at: string
          submitted_by: string
          ticket_id: string
          updated_at: string
          verified_at: string | null
          verified_by: string | null
        }
        Insert: {
          accepted_amount_cents?: number | null
          amount_cents: number
          created_at?: string
          customer_id: string
          duplicate_of_payment_id?: string | null
          id?: string
          idempotency_key?: string | null
          invoice_id: string
          method: Database["public"]["Enums"]["payment_method"]
          note?: string | null
          owner_id: string
          paid_on: string
          reference?: string | null
          reject_reason?: string | null
          source: Database["public"]["Enums"]["payment_source"]
          status?: Database["public"]["Enums"]["payment_status"]
          submitted_at?: string
          submitted_by: string
          ticket_id: string
          updated_at?: string
          verified_at?: string | null
          verified_by?: string | null
        }
        Update: {
          accepted_amount_cents?: number | null
          amount_cents?: number
          created_at?: string
          customer_id?: string
          duplicate_of_payment_id?: string | null
          id?: string
          idempotency_key?: string | null
          invoice_id?: string
          method?: Database["public"]["Enums"]["payment_method"]
          note?: string | null
          owner_id?: string
          paid_on?: string
          reference?: string | null
          reject_reason?: string | null
          source?: Database["public"]["Enums"]["payment_source"]
          status?: Database["public"]["Enums"]["payment_status"]
          submitted_at?: string
          submitted_by?: string
          ticket_id?: string
          updated_at?: string
          verified_at?: string | null
          verified_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payments_customer_fkey"
            columns: ["customer_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id", "owner_id"]
          },
          {
            foreignKeyName: "payments_duplicate_of_fkey"
            columns: ["duplicate_of_payment_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id", "owner_id"]
          },
          {
            foreignKeyName: "payments_invoice_fkey"
            columns: ["invoice_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id", "owner_id"]
          },
          {
            foreignKeyName: "payments_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owner_settings_effective"
            referencedColumns: ["owner_id"]
          },
          {
            foreignKeyName: "payments_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owners"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_submitted_by_fkey"
            columns: ["submitted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_ticket_fkey"
            columns: ["ticket_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "billing_cycle_tickets"
            referencedColumns: ["id", "owner_id"]
          },
          {
            foreignKeyName: "payments_verified_by_fkey"
            columns: ["verified_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_settings: {
        Row: {
          estimated_billing_enabled: boolean
          grace_period_days: number
          id: boolean
          late_fee_cents: number
          late_fee_enabled: boolean
          login_ip_max_failures: number
          login_ip_window_minutes: number
          login_lockout_minutes: number
          login_max_failures: number
          max_meter_rejections: number
          meter_deadline_days: number
          meter_reminder_days: number[]
          payment_due_days: number
          payment_overdue_reminder_days: number[]
          payment_reminder_before_days: number[]
          payment_reminder_on_due: boolean
          payment_slip_retention_days: number
          rejected_photo_retention_days: number
          review_deadline_hours: number
          review_escalation_hours: number
          review_reminder_hours: number[]
          service_ack_hours_normal: number
          service_ack_hours_urgent: number
          service_admin_escalation_hours_normal: number
          service_admin_escalation_hours_urgent: number
          session_idle_minutes: number
          session_max_hours: number
          slip_review_deadline_hours: number
          slip_review_escalation_hours: number
          slip_review_reminder_hours: number[]
          updated_at: string
          weekly_summary_dow: number
        }
        Insert: {
          estimated_billing_enabled?: boolean
          grace_period_days?: number
          id?: boolean
          late_fee_cents?: number
          late_fee_enabled?: boolean
          login_ip_max_failures?: number
          login_ip_window_minutes?: number
          login_lockout_minutes?: number
          login_max_failures?: number
          max_meter_rejections?: number
          meter_deadline_days?: number
          meter_reminder_days?: number[]
          payment_due_days?: number
          payment_overdue_reminder_days?: number[]
          payment_reminder_before_days?: number[]
          payment_reminder_on_due?: boolean
          payment_slip_retention_days?: number
          rejected_photo_retention_days?: number
          review_deadline_hours?: number
          review_escalation_hours?: number
          review_reminder_hours?: number[]
          service_ack_hours_normal?: number
          service_ack_hours_urgent?: number
          service_admin_escalation_hours_normal?: number
          service_admin_escalation_hours_urgent?: number
          session_idle_minutes?: number
          session_max_hours?: number
          slip_review_deadline_hours?: number
          slip_review_escalation_hours?: number
          slip_review_reminder_hours?: number[]
          updated_at?: string
          weekly_summary_dow?: number
        }
        Update: {
          estimated_billing_enabled?: boolean
          grace_period_days?: number
          id?: boolean
          late_fee_cents?: number
          late_fee_enabled?: boolean
          login_ip_max_failures?: number
          login_ip_window_minutes?: number
          login_lockout_minutes?: number
          login_max_failures?: number
          max_meter_rejections?: number
          meter_deadline_days?: number
          meter_reminder_days?: number[]
          payment_due_days?: number
          payment_overdue_reminder_days?: number[]
          payment_reminder_before_days?: number[]
          payment_reminder_on_due?: boolean
          payment_slip_retention_days?: number
          rejected_photo_retention_days?: number
          review_deadline_hours?: number
          review_escalation_hours?: number
          review_reminder_hours?: number[]
          service_ack_hours_normal?: number
          service_ack_hours_urgent?: number
          service_admin_escalation_hours_normal?: number
          service_admin_escalation_hours_urgent?: number
          session_idle_minutes?: number
          session_max_hours?: number
          slip_review_deadline_hours?: number
          slip_review_escalation_hours?: number
          slip_review_reminder_hours?: number[]
          updated_at?: string
          weekly_summary_dow?: number
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          created_by: string | null
          failed_login_count: number
          full_name: string
          id: string
          last_login_at: string | null
          locked_until: string | null
          must_change_password: boolean
          owner_id: string | null
          role: Database["public"]["Enums"]["user_role"]
          status: Database["public"]["Enums"]["account_status"]
          updated_at: string
          username: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          failed_login_count?: number
          full_name?: string
          id: string
          last_login_at?: string | null
          locked_until?: string | null
          must_change_password?: boolean
          owner_id?: string | null
          role: Database["public"]["Enums"]["user_role"]
          status?: Database["public"]["Enums"]["account_status"]
          updated_at?: string
          username: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          failed_login_count?: number
          full_name?: string
          id?: string
          last_login_at?: string | null
          locked_until?: string | null
          must_change_password?: boolean
          owner_id?: string | null
          role?: Database["public"]["Enums"]["user_role"]
          status?: Database["public"]["Enums"]["account_status"]
          updated_at?: string
          username?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profiles_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owner_settings_effective"
            referencedColumns: ["owner_id"]
          },
          {
            foreignKeyName: "profiles_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owners"
            referencedColumns: ["id"]
          },
        ]
      }
      rental_agreements: {
        Row: {
          billing_day: number | null
          bw_included: number
          bw_rate_cents: number
          closing_bw_reading: number | null
          closing_colour_reading: number | null
          colour_included: number | null
          colour_rate_cents: number | null
          created_at: string
          customer_id: string
          due_days: number
          end_date: string | null
          first_billing_date: string
          id: string
          initial_bw_reading: number
          initial_colour_reading: number | null
          installation_location: string | null
          late_fee_cents: number | null
          late_fee_mode: Database["public"]["Enums"]["late_fee_mode"]
          machine_id: string
          monthly_commitment_cents: number
          next_cycle_date: string
          next_cycle_no: number
          owner_id: string
          return_idempotency_key: string | null
          start_date: string
          status: Database["public"]["Enums"]["agreement_status"]
          terminated_at: string | null
          termination_reason: string | null
          updated_at: string
        }
        Insert: {
          billing_day?: number | null
          bw_included?: number
          bw_rate_cents: number
          closing_bw_reading?: number | null
          closing_colour_reading?: number | null
          colour_included?: number | null
          colour_rate_cents?: number | null
          created_at?: string
          customer_id: string
          due_days?: number
          end_date?: string | null
          first_billing_date: string
          id?: string
          initial_bw_reading?: number
          initial_colour_reading?: number | null
          installation_location?: string | null
          late_fee_cents?: number | null
          late_fee_mode?: Database["public"]["Enums"]["late_fee_mode"]
          machine_id: string
          monthly_commitment_cents: number
          next_cycle_date?: string
          next_cycle_no?: number
          owner_id: string
          return_idempotency_key?: string | null
          start_date: string
          status?: Database["public"]["Enums"]["agreement_status"]
          terminated_at?: string | null
          termination_reason?: string | null
          updated_at?: string
        }
        Update: {
          billing_day?: number | null
          bw_included?: number
          bw_rate_cents?: number
          closing_bw_reading?: number | null
          closing_colour_reading?: number | null
          colour_included?: number | null
          colour_rate_cents?: number | null
          created_at?: string
          customer_id?: string
          due_days?: number
          end_date?: string | null
          first_billing_date?: string
          id?: string
          initial_bw_reading?: number
          initial_colour_reading?: number | null
          installation_location?: string | null
          late_fee_cents?: number | null
          late_fee_mode?: Database["public"]["Enums"]["late_fee_mode"]
          machine_id?: string
          monthly_commitment_cents?: number
          next_cycle_date?: string
          next_cycle_no?: number
          owner_id?: string
          return_idempotency_key?: string | null
          start_date?: string
          status?: Database["public"]["Enums"]["agreement_status"]
          terminated_at?: string | null
          termination_reason?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "rental_agreements_customer_fkey"
            columns: ["customer_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id", "owner_id"]
          },
          {
            foreignKeyName: "rental_agreements_machine_fkey"
            columns: ["machine_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "machines"
            referencedColumns: ["id", "owner_id"]
          },
          {
            foreignKeyName: "rental_agreements_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owner_settings_effective"
            referencedColumns: ["owner_id"]
          },
          {
            foreignKeyName: "rental_agreements_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owners"
            referencedColumns: ["id"]
          },
        ]
      }
      service_request_history: {
        Row: {
          changed_at: string
          changed_by: string | null
          from_status:
            | Database["public"]["Enums"]["service_request_status"]
            | null
          id: string
          note: string | null
          owner_id: string
          request_id: string
          to_status: Database["public"]["Enums"]["service_request_status"]
        }
        Insert: {
          changed_at?: string
          changed_by?: string | null
          from_status?:
            | Database["public"]["Enums"]["service_request_status"]
            | null
          id?: string
          note?: string | null
          owner_id: string
          request_id: string
          to_status: Database["public"]["Enums"]["service_request_status"]
        }
        Update: {
          changed_at?: string
          changed_by?: string | null
          from_status?:
            | Database["public"]["Enums"]["service_request_status"]
            | null
          id?: string
          note?: string | null
          owner_id?: string
          request_id?: string
          to_status?: Database["public"]["Enums"]["service_request_status"]
        }
        Relationships: [
          {
            foreignKeyName: "service_request_history_changed_by_fkey"
            columns: ["changed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_request_history_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owner_settings_effective"
            referencedColumns: ["owner_id"]
          },
          {
            foreignKeyName: "service_request_history_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owners"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_request_history_request_fkey"
            columns: ["request_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "service_requests"
            referencedColumns: ["id", "owner_id"]
          },
        ]
      }
      service_requests: {
        Row: {
          acknowledged_at: string | null
          agreement_id: string | null
          assigned_to_name: string | null
          cancelled_at: string | null
          closed_at: string | null
          cost_cents: number | null
          created_at: string
          created_by: string
          customer_id: string
          description: string
          escalation_level: number
          id: string
          idempotency_key: string | null
          machine_id: string
          owner_id: string
          part_name: string | null
          parts_used: string | null
          planned_date: string | null
          preferred_date: string | null
          rating: number | null
          rating_comment: string | null
          resolved_at: string | null
          status: Database["public"]["Enums"]["service_request_status"]
          toner_colours: Database["public"]["Enums"]["toner_colour"][]
          type: Database["public"]["Enums"]["service_request_type"]
          updated_at: string
          urgency: Database["public"]["Enums"]["urgency"]
          work_done: string | null
        }
        Insert: {
          acknowledged_at?: string | null
          agreement_id?: string | null
          assigned_to_name?: string | null
          cancelled_at?: string | null
          closed_at?: string | null
          cost_cents?: number | null
          created_at?: string
          created_by: string
          customer_id: string
          description: string
          escalation_level?: number
          id?: string
          idempotency_key?: string | null
          machine_id: string
          owner_id: string
          part_name?: string | null
          parts_used?: string | null
          planned_date?: string | null
          preferred_date?: string | null
          rating?: number | null
          rating_comment?: string | null
          resolved_at?: string | null
          status?: Database["public"]["Enums"]["service_request_status"]
          toner_colours?: Database["public"]["Enums"]["toner_colour"][]
          type: Database["public"]["Enums"]["service_request_type"]
          updated_at?: string
          urgency?: Database["public"]["Enums"]["urgency"]
          work_done?: string | null
        }
        Update: {
          acknowledged_at?: string | null
          agreement_id?: string | null
          assigned_to_name?: string | null
          cancelled_at?: string | null
          closed_at?: string | null
          cost_cents?: number | null
          created_at?: string
          created_by?: string
          customer_id?: string
          description?: string
          escalation_level?: number
          id?: string
          idempotency_key?: string | null
          machine_id?: string
          owner_id?: string
          part_name?: string | null
          parts_used?: string | null
          planned_date?: string | null
          preferred_date?: string | null
          rating?: number | null
          rating_comment?: string | null
          resolved_at?: string | null
          status?: Database["public"]["Enums"]["service_request_status"]
          toner_colours?: Database["public"]["Enums"]["toner_colour"][]
          type?: Database["public"]["Enums"]["service_request_type"]
          updated_at?: string
          urgency?: Database["public"]["Enums"]["urgency"]
          work_done?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "service_requests_agreement_fkey"
            columns: ["agreement_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "rental_agreements"
            referencedColumns: ["id", "owner_id"]
          },
          {
            foreignKeyName: "service_requests_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_requests_customer_fkey"
            columns: ["customer_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id", "owner_id"]
          },
          {
            foreignKeyName: "service_requests_machine_fkey"
            columns: ["machine_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "machines"
            referencedColumns: ["id", "owner_id"]
          },
          {
            foreignKeyName: "service_requests_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owner_settings_effective"
            referencedColumns: ["owner_id"]
          },
          {
            foreignKeyName: "service_requests_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owners"
            referencedColumns: ["id"]
          },
        ]
      }
      subscription_plans: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          max_customers: number | null
          max_machines: number | null
          name: string
          price_cents: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          max_customers?: number | null
          max_machines?: number | null
          name: string
          price_cents?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          max_customers?: number | null
          max_machines?: number | null
          name?: string
          price_cents?: number
          updated_at?: string
        }
        Relationships: []
      }
      ticket_comments: {
        Row: {
          author_id: string
          body: string
          created_at: string
          id: string
          owner_id: string
          ticket_id: string
        }
        Insert: {
          author_id: string
          body: string
          created_at?: string
          id?: string
          owner_id: string
          ticket_id: string
        }
        Update: {
          author_id?: string
          body?: string
          created_at?: string
          id?: string
          owner_id?: string
          ticket_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ticket_comments_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ticket_comments_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owner_settings_effective"
            referencedColumns: ["owner_id"]
          },
          {
            foreignKeyName: "ticket_comments_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owners"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ticket_comments_ticket_fkey"
            columns: ["ticket_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "billing_cycle_tickets"
            referencedColumns: ["id", "owner_id"]
          },
        ]
      }
      ticket_events: {
        Row: {
          actor_id: string | null
          created_at: string
          event_type: Database["public"]["Enums"]["ticket_event_type"]
          from_status: Database["public"]["Enums"]["ticket_status"] | null
          id: string
          metadata: Json
          owner_id: string
          reason: string | null
          ticket_id: string
          to_status: Database["public"]["Enums"]["ticket_status"] | null
        }
        Insert: {
          actor_id?: string | null
          created_at?: string
          event_type: Database["public"]["Enums"]["ticket_event_type"]
          from_status?: Database["public"]["Enums"]["ticket_status"] | null
          id?: string
          metadata?: Json
          owner_id: string
          reason?: string | null
          ticket_id: string
          to_status?: Database["public"]["Enums"]["ticket_status"] | null
        }
        Update: {
          actor_id?: string | null
          created_at?: string
          event_type?: Database["public"]["Enums"]["ticket_event_type"]
          from_status?: Database["public"]["Enums"]["ticket_status"] | null
          id?: string
          metadata?: Json
          owner_id?: string
          reason?: string | null
          ticket_id?: string
          to_status?: Database["public"]["Enums"]["ticket_status"] | null
        }
        Relationships: [
          {
            foreignKeyName: "ticket_events_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ticket_events_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owner_settings_effective"
            referencedColumns: ["owner_id"]
          },
          {
            foreignKeyName: "ticket_events_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owners"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ticket_events_ticket_fkey"
            columns: ["ticket_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "billing_cycle_tickets"
            referencedColumns: ["id", "owner_id"]
          },
        ]
      }
    }
    Views: {
      agreement_deposit_balances: {
        Row: {
          agreement_id: string | null
          customer_id: string | null
          deducted_cents: number | null
          held_cents: number | null
          owner_id: string | null
          received_cents: number | null
          refunded_cents: number | null
          retained_cents: number | null
        }
        Relationships: [
          {
            foreignKeyName: "deposit_transactions_agreement_fkey"
            columns: ["agreement_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "rental_agreements"
            referencedColumns: ["id", "owner_id"]
          },
          {
            foreignKeyName: "deposit_transactions_customer_fkey"
            columns: ["customer_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id", "owner_id"]
          },
          {
            foreignKeyName: "deposit_transactions_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owner_settings_effective"
            referencedColumns: ["owner_id"]
          },
          {
            foreignKeyName: "deposit_transactions_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owners"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_balances: {
        Row: {
          customer_id: string | null
          outstanding_cents: number | null
          owner_id: string | null
          unpaid_invoices: number | null
        }
        Relationships: [
          {
            foreignKeyName: "invoices_customer_fkey"
            columns: ["customer_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id", "owner_id"]
          },
          {
            foreignKeyName: "invoices_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owner_settings_effective"
            referencedColumns: ["owner_id"]
          },
          {
            foreignKeyName: "invoices_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "owners"
            referencedColumns: ["id"]
          },
        ]
      }
      owner_settings_effective: {
        Row: {
          estimated_billing_enabled: boolean | null
          grace_period_days: number | null
          late_fee_cents: number | null
          late_fee_enabled: boolean | null
          max_meter_rejections: number | null
          meter_deadline_days: number | null
          meter_reminder_days: number[] | null
          owner_id: string | null
          payment_due_days: number | null
          payment_overdue_reminder_days: number[] | null
          payment_reminder_before_days: number[] | null
          payment_reminder_on_due: boolean | null
          payment_slip_retention_days: number | null
          rejected_photo_retention_days: number | null
          review_deadline_hours: number | null
          review_escalation_hours: number | null
          review_reminder_hours: number[] | null
          service_ack_hours_normal: number | null
          service_ack_hours_urgent: number | null
          service_admin_escalation_hours_normal: number | null
          service_admin_escalation_hours_urgent: number | null
          slip_review_deadline_hours: number | null
          slip_review_escalation_hours: number | null
          slip_review_reminder_hours: number[] | null
          weekly_summary_dow: number | null
        }
        Relationships: [
          {
            foreignKeyName: "owners_id_fkey"
            columns: ["owner_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      custom_access_token_hook: { Args: { event: Json }; Returns: Json }
      rpc_assign_invoice_number: {
        Args: { p_invoice_id: string }
        Returns: string
      }
      rpc_assign_machine: {
        Args: {
          p_actor_id: string
          p_customer_id: string
          p_machine_id: string
          p_terms: Json
          p_today: string
        }
        Returns: Json
      }
      rpc_complete_password_change: {
        Args: { p_user_id: string }
        Returns: Json
      }
      rpc_confirm_meter_submission: {
        Args: {
          p_actor_id: string
          p_branding_snapshot?: Json
          p_due_date: string
          p_notifications?: Json
          p_rollover_confirmed?: boolean
          p_stage_due_at: string
          p_submission_id: string
          p_ticket_id: string
        }
        Returns: Json
      }
      rpc_login_gate_state: {
        Args: { p_ip: unknown; p_username: string }
        Returns: Json
      }
      rpc_open_billing_cycle: {
        Args: {
          p_agreement_id: string
          p_cycle_no: number
          p_notifications?: Json
          p_stage_due_at: string
        }
        Returns: Json
      }
      rpc_provision_account: {
        Args: {
          p_created_by: string
          p_details?: Json
          p_full_name: string
          p_must_change_password?: boolean
          p_owner_id: string
          p_role: Database["public"]["Enums"]["user_role"]
          p_user_id: string
          p_username: string
        }
        Returns: Json
      }
      rpc_reassign_machine: {
        Args: {
          p_actor_id: string
          p_agreement_id: string
          p_customer_id: string
          p_return: Json
          p_terms: Json
          p_today: string
        }
        Returns: Json
      }
      rpc_record_login_attempt: {
        Args: {
          p_ip: unknown
          p_reason?: string
          p_success: boolean
          p_user_agent?: string
          p_username: string
        }
        Returns: Json
      }
      rpc_reject_meter_submission: {
        Args: {
          p_actor_id: string
          p_notifications?: Json
          p_photo_expires_at: string
          p_reason: string
          p_stage_due_at: string
          p_submission_id: string
          p_ticket_id: string
        }
        Returns: Json
      }
      rpc_reset_account_password: {
        Args: { p_actor_id: string; p_target_id: string }
        Returns: Json
      }
      rpc_return_machine: {
        Args: {
          p_actor_id: string
          p_agreement_id: string
          p_return: Json
          p_today: string
        }
        Returns: Json
      }
      rpc_save_company_profile: {
        Args: { p_details: Json; p_owner_id: string }
        Returns: Json
      }
      rpc_session_state: { Args: { p_user_id: string }; Returns: Json }
      rpc_set_account_status: {
        Args: {
          p_actor_id: string
          p_reason: string
          p_status: Database["public"]["Enums"]["account_status"]
          p_target_id: string
        }
        Returns: Json
      }
      rpc_set_invoice_credit: {
        Args: {
          p_actor_id: string
          p_credit_id: string
          p_include: boolean
          p_invoice: Json
          p_invoice_id: string
          p_note: string
        }
        Returns: Json
      }
      rpc_set_machine_status: {
        Args: {
          p_actor_id: string
          p_machine_id: string
          p_reason: string
          p_status: Database["public"]["Enums"]["machine_status"]
        }
        Returns: Json
      }
      rpc_settle_deposit: {
        Args: {
          p_actor_id: string
          p_agreement_id: string
          p_settlement: Json
          p_today: string
        }
        Returns: Json
      }
      rpc_submit_meter_reading: {
        Args: {
          p_actor_id: string
          p_anomaly_flag?: string
          p_idempotency_key: string
          p_invoice: Json
          p_note?: string
          p_notifications?: Json
          p_photo: Json
          p_readings: Json
          p_source: Database["public"]["Enums"]["reading_source"]
          p_stage_due_at: string
          p_ticket_id: string
        }
        Returns: Json
      }
      rpc_submit_payment: {
        Args: {
          p_actor_id: string
          p_idempotency_key: string
          p_notifications?: Json
          p_payment: Json
          p_slip: Json
          p_source: Database["public"]["Enums"]["payment_source"]
          p_stage_due_at: string
          p_ticket_id: string
        }
        Returns: Json
      }
      rpc_transition_ticket: {
        Args: {
          p_actor_id: string
          p_event_type?: Database["public"]["Enums"]["ticket_event_type"]
          p_from: Database["public"]["Enums"]["ticket_status"]
          p_invoice_status?: Database["public"]["Enums"]["invoice_status"]
          p_metadata?: Json
          p_notifications?: Json
          p_reason?: string
          p_stage_due_at?: string
          p_ticket_id: string
          p_to: Database["public"]["Enums"]["ticket_status"]
        }
        Returns: Json
      }
      rpc_update_agreement_terms: {
        Args: {
          p_actor_id: string
          p_agreement_id: string
          p_note: string
          p_terms: Json
          p_today: string
        }
        Returns: Json
      }
      rpc_update_customer: {
        Args: { p_actor_id: string; p_customer_id: string; p_details: Json }
        Returns: Json
      }
      rpc_update_owner: {
        Args: { p_actor_id: string; p_details: Json; p_owner_id: string }
        Returns: Json
      }
      rpc_verify_payment: {
        Args: {
          p_accept: boolean
          p_accepted_amount_cents?: number
          p_actor_id: string
          p_notifications?: Json
          p_payment_id: string
          p_reason?: string
          p_stage_due_at?: string
          p_ticket_id: string
        }
        Returns: Json
      }
      rpc_write_audit: {
        Args: {
          p_action: string
          p_actor_id: string
          p_details?: Json
          p_entity: string
          p_entity_id?: string
          p_owner_id?: string
        }
        Returns: undefined
      }
    }
    Enums: {
      account_status: "ACTIVE" | "SUSPENDED" | "DEACTIVATED"
      agreement_status: "ACTIVE" | "SUSPENDED" | "TERMINATED"
      counter_type: "BW" | "COLOUR"
      credit_kind:
        | "OVERPAYMENT"
        | "ESTIMATE_RECONCILIATION"
        | "CANCELLED_INVOICE"
        | "ADVANCE"
        | "MANUAL"
      credit_status: "AVAILABLE" | "APPLIED" | "REFUNDED"
      deposit_transaction_kind:
        | "RECEIVED"
        | "DEDUCTED"
        | "REFUNDED"
        | "RETAINED"
      dispute_status: "OPEN" | "RESOLVED" | "REJECTED"
      idempotency_scope:
        | "METER_SUBMISSION"
        | "PAYMENT_SUBMISSION"
        | "SERVICE_REQUEST"
        | "TICKET_COMMENT"
      invoice_line_type:
        | "COMMITMENT"
        | "BW_EXCESS"
        | "COLOUR_EXCESS"
        | "LATE_FEE"
        | "CREDIT"
        | "ADJUSTMENT"
      invoice_status:
        | "DRAFT"
        | "AWAITING_PAYMENT"
        | "PAYMENT_SUBMITTED"
        | "PARTIALLY_PAID"
        | "PAID"
        | "OVERDUE"
        | "DISPUTED"
        | "REJECTED"
        | "CANCELLED"
      invoice_type: "NORMAL" | "ESTIMATED"
      late_fee_mode: "OWNER_DEFAULT" | "CUSTOM" | "NONE"
      machine_status: "AVAILABLE" | "RENTED" | "UNDER_REPAIR" | "RETIRED"
      machine_type: "MONO" | "COLOUR"
      meter_submission_status:
        | "PENDING_REVIEW"
        | "CONFIRMED"
        | "REJECTED"
        | "SUPERSEDED"
      notification_channel: "IN_APP" | "EMAIL" | "SMS" | "WHATSAPP"
      notification_status: "PENDING" | "SENT" | "FAILED" | "READ"
      payment_method:
        | "BANK_TRANSFER"
        | "DEPOSIT"
        | "CASH"
        | "CHEQUE"
        | "ONLINE"
        | "OTHER"
        | "SECURITY_DEPOSIT"
      payment_source: "CUSTOMER_SLIP" | "OWNER_MANUAL"
      payment_status: "SUBMITTED" | "ACCEPTED" | "REJECTED" | "PARTIAL"
      reading_source: "CUSTOMER" | "OWNER_MANUAL"
      service_request_status:
        | "NEW"
        | "ACKNOWLEDGED"
        | "ASSIGNED"
        | "IN_PROGRESS"
        | "RESOLVED"
        | "CLOSED"
        | "CANCELLED"
      service_request_type:
        | "BREAKDOWN"
        | "TONER"
        | "SPARE_PART"
        | "MAINTENANCE"
        | "OTHER"
      ticket_event_type:
        | "CREATED"
        | "STATUS_CHANGE"
        | "REMINDER"
        | "ESCALATION"
        | "CORRECTION"
        | "MANUAL_ENTRY"
        | "BASELINE"
        | "NOTE"
      ticket_status:
        | "METER_REQUESTED"
        | "PENDING_OWNER_REVIEW"
        | "AWAITING_PAYMENT"
        | "PAYMENT_SUBMITTED"
        | "CLOSED"
        | "OVERDUE"
        | "PARTIALLY_PAID"
        | "DISPUTED"
        | "CANCELLED"
        | "REOPENED"
      toner_colour: "BLACK" | "CYAN" | "MAGENTA" | "YELLOW"
      urgency: "LOW" | "NORMAL" | "HIGH" | "URGENT"
      user_role: "ADMIN" | "OWNER" | "CUSTOMER"
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
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
    Enums: {
      account_status: ["ACTIVE", "SUSPENDED", "DEACTIVATED"],
      agreement_status: ["ACTIVE", "SUSPENDED", "TERMINATED"],
      counter_type: ["BW", "COLOUR"],
      credit_kind: [
        "OVERPAYMENT",
        "ESTIMATE_RECONCILIATION",
        "CANCELLED_INVOICE",
        "ADVANCE",
        "MANUAL",
      ],
      credit_status: ["AVAILABLE", "APPLIED", "REFUNDED"],
      deposit_transaction_kind: [
        "RECEIVED",
        "DEDUCTED",
        "REFUNDED",
        "RETAINED",
      ],
      dispute_status: ["OPEN", "RESOLVED", "REJECTED"],
      idempotency_scope: [
        "METER_SUBMISSION",
        "PAYMENT_SUBMISSION",
        "SERVICE_REQUEST",
        "TICKET_COMMENT",
      ],
      invoice_line_type: [
        "COMMITMENT",
        "BW_EXCESS",
        "COLOUR_EXCESS",
        "LATE_FEE",
        "CREDIT",
        "ADJUSTMENT",
      ],
      invoice_status: [
        "DRAFT",
        "AWAITING_PAYMENT",
        "PAYMENT_SUBMITTED",
        "PARTIALLY_PAID",
        "PAID",
        "OVERDUE",
        "DISPUTED",
        "REJECTED",
        "CANCELLED",
      ],
      invoice_type: ["NORMAL", "ESTIMATED"],
      late_fee_mode: ["OWNER_DEFAULT", "CUSTOM", "NONE"],
      machine_status: ["AVAILABLE", "RENTED", "UNDER_REPAIR", "RETIRED"],
      machine_type: ["MONO", "COLOUR"],
      meter_submission_status: [
        "PENDING_REVIEW",
        "CONFIRMED",
        "REJECTED",
        "SUPERSEDED",
      ],
      notification_channel: ["IN_APP", "EMAIL", "SMS", "WHATSAPP"],
      notification_status: ["PENDING", "SENT", "FAILED", "READ"],
      payment_method: [
        "BANK_TRANSFER",
        "DEPOSIT",
        "CASH",
        "CHEQUE",
        "ONLINE",
        "OTHER",
        "SECURITY_DEPOSIT",
      ],
      payment_source: ["CUSTOMER_SLIP", "OWNER_MANUAL"],
      payment_status: ["SUBMITTED", "ACCEPTED", "REJECTED", "PARTIAL"],
      reading_source: ["CUSTOMER", "OWNER_MANUAL"],
      service_request_status: [
        "NEW",
        "ACKNOWLEDGED",
        "ASSIGNED",
        "IN_PROGRESS",
        "RESOLVED",
        "CLOSED",
        "CANCELLED",
      ],
      service_request_type: [
        "BREAKDOWN",
        "TONER",
        "SPARE_PART",
        "MAINTENANCE",
        "OTHER",
      ],
      ticket_event_type: [
        "CREATED",
        "STATUS_CHANGE",
        "REMINDER",
        "ESCALATION",
        "CORRECTION",
        "MANUAL_ENTRY",
        "BASELINE",
        "NOTE",
      ],
      ticket_status: [
        "METER_REQUESTED",
        "PENDING_OWNER_REVIEW",
        "AWAITING_PAYMENT",
        "PAYMENT_SUBMITTED",
        "CLOSED",
        "OVERDUE",
        "PARTIALLY_PAID",
        "DISPUTED",
        "CANCELLED",
        "REOPENED",
      ],
      toner_colour: ["BLACK", "CYAN", "MAGENTA", "YELLOW"],
      urgency: ["LOW", "NORMAL", "HIGH", "URGENT"],
      user_role: ["ADMIN", "OWNER", "CUSTOMER"],
    },
  },
} as const
