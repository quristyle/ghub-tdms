--
-- PostgreSQL database dump
--

\restrict vevCOXGIR83W30lY3EqOKMdfIXU2O5I8OET1sdoRQwrHPA1K4arRvz3LaDL3EgR

-- Dumped from database version 16.14
-- Dumped by pg_dump version 16.14

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: alembic_version; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alembic_version (
    version_num character varying(32) NOT NULL
);


--
-- Name: archive_batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.archive_batches (
    id integer NOT NULL,
    kind text NOT NULL,
    label text NOT NULL,
    original_path text,
    archived_by integer NOT NULL,
    archived_at timestamp with time zone DEFAULT now() NOT NULL,
    restored_at timestamp with time zone,
    reason text
);


--
-- Name: archive_batches_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.archive_batches_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: archive_batches_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.archive_batches_id_seq OWNED BY public.archive_batches.id;


--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log (
    id integer NOT NULL,
    user_id integer,
    action text NOT NULL,
    document_id integer,
    detail jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    screen text
);


--
-- Name: audit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.audit_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audit_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.audit_log_id_seq OWNED BY public.audit_log.id;


--
-- Name: backup_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.backup_runs (
    id integer NOT NULL,
    kind text NOT NULL,
    scope text NOT NULL,
    seq integer NOT NULL,
    base_run_id integer,
    set_key text NOT NULL,
    filename text NOT NULL,
    dest_dir text,
    delivery text NOT NULL,
    file_size bigint DEFAULT '0'::bigint NOT NULL,
    source_bytes bigint DEFAULT '0'::bigint NOT NULL,
    file_count integer DEFAULT 0 NOT NULL,
    removed_count integer DEFAULT 0 NOT NULL,
    manifest_path text,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    downloaded_at timestamp with time zone,
    download_count integer DEFAULT 0 NOT NULL,
    note text,
    file_deleted_at timestamp with time zone,
    file_deleted_by integer
);


--
-- Name: backup_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.backup_runs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: backup_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.backup_runs_id_seq OWNED BY public.backup_runs.id;


--
-- Name: distributions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.distributions (
    id integer NOT NULL,
    document_id integer NOT NULL,
    rev_at_distribution integer NOT NULL,
    vendor text NOT NULL,
    project_id integer,
    purpose text NOT NULL,
    distributed_by integer NOT NULL,
    distributed_at timestamp with time zone DEFAULT now() NOT NULL,
    file_saved_path text NOT NULL,
    returned_file_id integer,
    returned_at timestamp with time zone,
    return_note text,
    purpose_note text,
    zip_filename text,
    keep_paths boolean DEFAULT true NOT NULL
);


--
-- Name: distributions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.distributions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: distributions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.distributions_id_seq OWNED BY public.distributions.id;


--
-- Name: documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.documents (
    id integer NOT NULL,
    doc_class text NOT NULL,
    drawing_no text NOT NULL,
    title text NOT NULL,
    category text,
    discipline text,
    doc_type text,
    isbl_osbl text,
    elevation text,
    area text,
    source_path text,
    is_isometric boolean DEFAULT false NOT NULL,
    equipment_tag text,
    project_id integer,
    current_rev integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'ACTIVE'::text NOT NULL,
    has_dwg boolean DEFAULT false NOT NULL,
    has_pdf boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_archived boolean DEFAULT false NOT NULL,
    archive_batch_id integer
);


--
-- Name: documents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.documents_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: documents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.documents_id_seq OWNED BY public.documents.id;


--
-- Name: equipment_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.equipment_types (
    id integer NOT NULL,
    name text NOT NULL,
    is_hidden boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: equipment_types_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.equipment_types_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: equipment_types_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.equipment_types_id_seq OWNED BY public.equipment_types.id;


--
-- Name: files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.files (
    id integer NOT NULL,
    document_id integer NOT NULL,
    rev integer NOT NULL,
    branch text,
    file_ext text NOT NULL,
    file_path text NOT NULL,
    file_size bigint NOT NULL,
    sha256 text NOT NULL,
    uploaded_by integer NOT NULL,
    vendor_name text,
    project_id integer,
    vendor_labeled_rev text,
    rev_mismatch_warning boolean DEFAULT false NOT NULL,
    review_status text NOT NULL,
    review_note text,
    uploaded_at timestamp with time zone DEFAULT now() NOT NULL,
    is_current boolean DEFAULT false NOT NULL,
    original_filename text NOT NULL,
    pairing_folder text
);


--
-- Name: files_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.files_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: files_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.files_id_seq OWNED BY public.files.id;


--
-- Name: folder_placeholders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.folder_placeholders (
    id integer NOT NULL,
    path text NOT NULL,
    created_by integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: folder_placeholders_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.folder_placeholders_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: folder_placeholders_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.folder_placeholders_id_seq OWNED BY public.folder_placeholders.id;


--
-- Name: group_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_permissions (
    id integer NOT NULL,
    group_id integer NOT NULL,
    node_key text NOT NULL,
    allowed boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: group_permissions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.group_permissions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: group_permissions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.group_permissions_id_seq OWNED BY public.group_permissions.id;


--
-- Name: groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.groups (
    id integer NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: groups_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.groups_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: groups_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.groups_id_seq OWNED BY public.groups.id;


--
-- Name: hidden_vendors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hidden_vendors (
    id integer NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: hidden_vendors_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.hidden_vendors_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: hidden_vendors_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.hidden_vendors_id_seq OWNED BY public.hidden_vendors.id;


--
-- Name: import_issues; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.import_issues (
    id integer NOT NULL,
    reason text NOT NULL,
    zip_relative_path text NOT NULL,
    original_filename text NOT NULL,
    stored_file_path text NOT NULL,
    file_size bigint NOT NULL,
    sha256 text NOT NULL,
    vendor_name text NOT NULL,
    project_id integer,
    uploaded_by integer NOT NULL,
    uploaded_at timestamp with time zone NOT NULL,
    status text DEFAULT 'PENDING'::text NOT NULL,
    resolved_document_id integer,
    resolved_rev integer,
    resolved_branch text,
    resolve_note text,
    resolved_at timestamp with time zone,
    intended_document_id integer,
    detail jsonb,
    files jsonb
);


--
-- Name: import_issues_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.import_issues_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: import_issues_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.import_issues_id_seq OWNED BY public.import_issues.id;


--
-- Name: mdb_doc_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mdb_doc_types (
    id integer NOT NULL,
    name text NOT NULL,
    is_hidden boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mdb_doc_types_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mdb_doc_types_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mdb_doc_types_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mdb_doc_types_id_seq OWNED BY public.mdb_doc_types.id;


--
-- Name: mdb_file_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mdb_file_tags (
    id integer NOT NULL,
    mdb_file_id integer NOT NULL,
    tag_no text NOT NULL
);


--
-- Name: mdb_file_tags_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mdb_file_tags_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mdb_file_tags_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mdb_file_tags_id_seq OWNED BY public.mdb_file_tags.id;


--
-- Name: mdb_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mdb_files (
    id integer NOT NULL,
    storage_path text NOT NULL,
    source_path text NOT NULL,
    original_filename text NOT NULL,
    file_ext text NOT NULL,
    file_size bigint NOT NULL,
    sha256 text NOT NULL,
    is_pdf boolean DEFAULT false NOT NULL,
    equipment_type text,
    project_id integer,
    year integer,
    note text,
    uploaded_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_archived boolean DEFAULT false NOT NULL,
    archive_batch_id integer,
    pairing_folder text,
    doc_type text
);


--
-- Name: mdb_files_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mdb_files_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mdb_files_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mdb_files_id_seq OWNED BY public.mdb_files.id;


--
-- Name: mdb_folder_placeholders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mdb_folder_placeholders (
    id integer NOT NULL,
    path text NOT NULL,
    created_by integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mdb_folder_placeholders_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mdb_folder_placeholders_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mdb_folder_placeholders_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mdb_folder_placeholders_id_seq OWNED BY public.mdb_folder_placeholders.id;


--
-- Name: mdb_tag_change_reasons; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mdb_tag_change_reasons (
    id integer NOT NULL,
    name text NOT NULL,
    is_hidden boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mdb_tag_change_reasons_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mdb_tag_change_reasons_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mdb_tag_change_reasons_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mdb_tag_change_reasons_id_seq OWNED BY public.mdb_tag_change_reasons.id;


--
-- Name: mdb_tag_histories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mdb_tag_histories (
    id integer NOT NULL,
    base_tag text NOT NULL,
    action text NOT NULL,
    new_tag text,
    project_id integer,
    note_label text,
    note_year text,
    note_project text,
    note_reason text,
    note_memo text,
    note_line text,
    applied_changes jsonb,
    applied_doc_count integer DEFAULT 0 NOT NULL,
    applied_at timestamp with time zone,
    applied_by integer,
    reverted_at timestamp with time zone,
    reverted_by integer,
    created_by integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    auto_apply boolean DEFAULT true NOT NULL
);


--
-- Name: mdb_tag_histories_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mdb_tag_histories_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mdb_tag_histories_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mdb_tag_histories_id_seq OWNED BY public.mdb_tag_histories.id;


--
-- Name: projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.projects (
    id integer NOT NULL,
    name text NOT NULL,
    project_no text,
    vendor text,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    is_hidden boolean DEFAULT false NOT NULL
);


--
-- Name: projects_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.projects_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: projects_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.projects_id_seq OWNED BY public.projects.id;


--
-- Name: user_favorites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_favorites (
    id integer NOT NULL,
    user_id integer NOT NULL,
    kind text NOT NULL,
    document_id integer,
    mdb_file_id integer,
    name text NOT NULL,
    description text,
    has_markup boolean DEFAULT false NOT NULL,
    markup_path text,
    pdf_file_id integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    source_name text,
    view_mode text
);


--
-- Name: user_favorites_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_favorites_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_favorites_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_favorites_id_seq OWNED BY public.user_favorites.id;


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id integer NOT NULL,
    username text NOT NULL,
    password_hash text NOT NULL,
    name text NOT NULL,
    role text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    employment_status text DEFAULT 'ACTIVE'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    group_id integer,
    last_login_at timestamp with time zone,
    must_change_password boolean DEFAULT false NOT NULL,
    failed_login_count integer DEFAULT 0 NOT NULL,
    locked_until timestamp with time zone
);


--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- Name: archive_batches id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.archive_batches ALTER COLUMN id SET DEFAULT nextval('public.archive_batches_id_seq'::regclass);


--
-- Name: audit_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log ALTER COLUMN id SET DEFAULT nextval('public.audit_log_id_seq'::regclass);


--
-- Name: backup_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_runs ALTER COLUMN id SET DEFAULT nextval('public.backup_runs_id_seq'::regclass);


--
-- Name: distributions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.distributions ALTER COLUMN id SET DEFAULT nextval('public.distributions_id_seq'::regclass);


--
-- Name: documents id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents ALTER COLUMN id SET DEFAULT nextval('public.documents_id_seq'::regclass);


--
-- Name: equipment_types id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_types ALTER COLUMN id SET DEFAULT nextval('public.equipment_types_id_seq'::regclass);


--
-- Name: files id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.files ALTER COLUMN id SET DEFAULT nextval('public.files_id_seq'::regclass);


--
-- Name: folder_placeholders id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.folder_placeholders ALTER COLUMN id SET DEFAULT nextval('public.folder_placeholders_id_seq'::regclass);


--
-- Name: group_permissions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_permissions ALTER COLUMN id SET DEFAULT nextval('public.group_permissions_id_seq'::regclass);


--
-- Name: groups id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.groups ALTER COLUMN id SET DEFAULT nextval('public.groups_id_seq'::regclass);


--
-- Name: hidden_vendors id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hidden_vendors ALTER COLUMN id SET DEFAULT nextval('public.hidden_vendors_id_seq'::regclass);


--
-- Name: import_issues id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_issues ALTER COLUMN id SET DEFAULT nextval('public.import_issues_id_seq'::regclass);


--
-- Name: mdb_doc_types id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mdb_doc_types ALTER COLUMN id SET DEFAULT nextval('public.mdb_doc_types_id_seq'::regclass);


--
-- Name: mdb_file_tags id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mdb_file_tags ALTER COLUMN id SET DEFAULT nextval('public.mdb_file_tags_id_seq'::regclass);


--
-- Name: mdb_files id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mdb_files ALTER COLUMN id SET DEFAULT nextval('public.mdb_files_id_seq'::regclass);


--
-- Name: mdb_folder_placeholders id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mdb_folder_placeholders ALTER COLUMN id SET DEFAULT nextval('public.mdb_folder_placeholders_id_seq'::regclass);


--
-- Name: mdb_tag_change_reasons id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mdb_tag_change_reasons ALTER COLUMN id SET DEFAULT nextval('public.mdb_tag_change_reasons_id_seq'::regclass);


--
-- Name: mdb_tag_histories id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mdb_tag_histories ALTER COLUMN id SET DEFAULT nextval('public.mdb_tag_histories_id_seq'::regclass);


--
-- Name: projects id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects ALTER COLUMN id SET DEFAULT nextval('public.projects_id_seq'::regclass);


--
-- Name: user_favorites id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_favorites ALTER COLUMN id SET DEFAULT nextval('public.user_favorites_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Name: alembic_version alembic_version_pkc; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alembic_version
    ADD CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num);


--
-- Name: archive_batches archive_batches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.archive_batches
    ADD CONSTRAINT archive_batches_pkey PRIMARY KEY (id);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: backup_runs backup_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_runs
    ADD CONSTRAINT backup_runs_pkey PRIMARY KEY (id);


--
-- Name: distributions distributions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.distributions
    ADD CONSTRAINT distributions_pkey PRIMARY KEY (id);


--
-- Name: documents documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_pkey PRIMARY KEY (id);


--
-- Name: equipment_types equipment_types_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_types
    ADD CONSTRAINT equipment_types_name_key UNIQUE (name);


--
-- Name: equipment_types equipment_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_types
    ADD CONSTRAINT equipment_types_pkey PRIMARY KEY (id);


--
-- Name: files files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_pkey PRIMARY KEY (id);


--
-- Name: folder_placeholders folder_placeholders_path_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.folder_placeholders
    ADD CONSTRAINT folder_placeholders_path_key UNIQUE (path);


--
-- Name: folder_placeholders folder_placeholders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.folder_placeholders
    ADD CONSTRAINT folder_placeholders_pkey PRIMARY KEY (id);


--
-- Name: group_permissions group_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_permissions
    ADD CONSTRAINT group_permissions_pkey PRIMARY KEY (id);


--
-- Name: groups groups_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.groups
    ADD CONSTRAINT groups_name_key UNIQUE (name);


--
-- Name: groups groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.groups
    ADD CONSTRAINT groups_pkey PRIMARY KEY (id);


--
-- Name: hidden_vendors hidden_vendors_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hidden_vendors
    ADD CONSTRAINT hidden_vendors_name_key UNIQUE (name);


--
-- Name: hidden_vendors hidden_vendors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hidden_vendors
    ADD CONSTRAINT hidden_vendors_pkey PRIMARY KEY (id);


--
-- Name: import_issues import_issues_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_issues
    ADD CONSTRAINT import_issues_pkey PRIMARY KEY (id);


--
-- Name: mdb_doc_types mdb_doc_types_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mdb_doc_types
    ADD CONSTRAINT mdb_doc_types_name_key UNIQUE (name);


--
-- Name: mdb_doc_types mdb_doc_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mdb_doc_types
    ADD CONSTRAINT mdb_doc_types_pkey PRIMARY KEY (id);


--
-- Name: mdb_file_tags mdb_file_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mdb_file_tags
    ADD CONSTRAINT mdb_file_tags_pkey PRIMARY KEY (id);


--
-- Name: mdb_files mdb_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mdb_files
    ADD CONSTRAINT mdb_files_pkey PRIMARY KEY (id);


--
-- Name: mdb_folder_placeholders mdb_folder_placeholders_path_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mdb_folder_placeholders
    ADD CONSTRAINT mdb_folder_placeholders_path_key UNIQUE (path);


--
-- Name: mdb_folder_placeholders mdb_folder_placeholders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mdb_folder_placeholders
    ADD CONSTRAINT mdb_folder_placeholders_pkey PRIMARY KEY (id);


--
-- Name: mdb_tag_change_reasons mdb_tag_change_reasons_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mdb_tag_change_reasons
    ADD CONSTRAINT mdb_tag_change_reasons_name_key UNIQUE (name);


--
-- Name: mdb_tag_change_reasons mdb_tag_change_reasons_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mdb_tag_change_reasons
    ADD CONSTRAINT mdb_tag_change_reasons_pkey PRIMARY KEY (id);


--
-- Name: mdb_tag_histories mdb_tag_histories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mdb_tag_histories
    ADD CONSTRAINT mdb_tag_histories_pkey PRIMARY KEY (id);


--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);


--
-- Name: group_permissions uq_group_permissions_group_node; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_permissions
    ADD CONSTRAINT uq_group_permissions_group_node UNIQUE (group_id, node_key);


--
-- Name: user_favorites user_favorites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_favorites
    ADD CONSTRAINT user_favorites_pkey PRIMARY KEY (id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key UNIQUE (username);


--
-- Name: ix_audit_log_screen; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_audit_log_screen ON public.audit_log USING btree (screen);


--
-- Name: ix_backup_runs_kind_seq; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_backup_runs_kind_seq ON public.backup_runs USING btree (kind, seq);


--
-- Name: ix_backup_runs_set_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_backup_runs_set_key ON public.backup_runs USING btree (set_key);


--
-- Name: ix_distributions_document_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_distributions_document_id ON public.distributions USING btree (document_id);


--
-- Name: ix_distributions_purpose_returned_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_distributions_purpose_returned_at ON public.distributions USING btree (purpose, returned_at);


--
-- Name: ix_documents_discipline; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_documents_discipline ON public.documents USING btree (discipline);


--
-- Name: ix_documents_doc_class; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_documents_doc_class ON public.documents USING btree (doc_class);


--
-- Name: ix_documents_doc_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_documents_doc_type ON public.documents USING btree (doc_type);


--
-- Name: ix_documents_drawing_no; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_documents_drawing_no ON public.documents USING btree (drawing_no);


--
-- Name: ix_documents_is_archived; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_documents_is_archived ON public.documents USING btree (is_archived);


--
-- Name: ix_documents_is_isometric; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_documents_is_isometric ON public.documents USING btree (is_isometric);


--
-- Name: ix_files_document_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_files_document_id ON public.files USING btree (document_id);


--
-- Name: ix_files_document_id_is_current; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_files_document_id_is_current ON public.files USING btree (document_id, is_current);


--
-- Name: ix_group_permissions_group_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_group_permissions_group_id ON public.group_permissions USING btree (group_id);


--
-- Name: ix_mdb_file_tags_file_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_mdb_file_tags_file_id ON public.mdb_file_tags USING btree (mdb_file_id);


--
-- Name: ix_mdb_file_tags_tag_no; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_mdb_file_tags_tag_no ON public.mdb_file_tags USING btree (tag_no);


--
-- Name: ix_mdb_files_doc_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_mdb_files_doc_type ON public.mdb_files USING btree (doc_type);


--
-- Name: ix_mdb_files_equipment_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_mdb_files_equipment_type ON public.mdb_files USING btree (equipment_type);


--
-- Name: ix_mdb_files_is_archived; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_mdb_files_is_archived ON public.mdb_files USING btree (is_archived);


--
-- Name: ix_mdb_files_project_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_mdb_files_project_id ON public.mdb_files USING btree (project_id);


--
-- Name: ix_mdb_tag_histories_base_tag; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_mdb_tag_histories_base_tag ON public.mdb_tag_histories USING btree (base_tag);


--
-- Name: ix_user_favorites_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_user_favorites_user_id ON public.user_favorites USING btree (user_id);


--
-- Name: archive_batches archive_batches_archived_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.archive_batches
    ADD CONSTRAINT archive_batches_archived_by_fkey FOREIGN KEY (archived_by) REFERENCES public.users(id);


--
-- Name: audit_log audit_log_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id);


--
-- Name: audit_log audit_log_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: backup_runs backup_runs_base_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_runs
    ADD CONSTRAINT backup_runs_base_run_id_fkey FOREIGN KEY (base_run_id) REFERENCES public.backup_runs(id);


--
-- Name: backup_runs backup_runs_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_runs
    ADD CONSTRAINT backup_runs_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: distributions distributions_distributed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.distributions
    ADD CONSTRAINT distributions_distributed_by_fkey FOREIGN KEY (distributed_by) REFERENCES public.users(id);


--
-- Name: distributions distributions_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.distributions
    ADD CONSTRAINT distributions_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id);


--
-- Name: distributions distributions_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.distributions
    ADD CONSTRAINT distributions_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id);


--
-- Name: distributions distributions_returned_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.distributions
    ADD CONSTRAINT distributions_returned_file_id_fkey FOREIGN KEY (returned_file_id) REFERENCES public.files(id);


--
-- Name: documents documents_archive_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_archive_batch_id_fkey FOREIGN KEY (archive_batch_id) REFERENCES public.archive_batches(id);


--
-- Name: documents documents_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id);


--
-- Name: files files_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id);


--
-- Name: files files_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id);


--
-- Name: files files_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id);


--
-- Name: backup_runs fk_backup_runs_file_deleted_by_users; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_runs
    ADD CONSTRAINT fk_backup_runs_file_deleted_by_users FOREIGN KEY (file_deleted_by) REFERENCES public.users(id);


--
-- Name: import_issues fk_import_issues_intended_document; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_issues
    ADD CONSTRAINT fk_import_issues_intended_document FOREIGN KEY (intended_document_id) REFERENCES public.documents(id);


--
-- Name: folder_placeholders folder_placeholders_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.folder_placeholders
    ADD CONSTRAINT folder_placeholders_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: group_permissions group_permissions_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_permissions
    ADD CONSTRAINT group_permissions_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id);


--
-- Name: import_issues import_issues_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_issues
    ADD CONSTRAINT import_issues_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id);


--
-- Name: import_issues import_issues_resolved_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_issues
    ADD CONSTRAINT import_issues_resolved_document_id_fkey FOREIGN KEY (resolved_document_id) REFERENCES public.documents(id);


--
-- Name: import_issues import_issues_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_issues
    ADD CONSTRAINT import_issues_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id);


--
-- Name: mdb_file_tags mdb_file_tags_mdb_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mdb_file_tags
    ADD CONSTRAINT mdb_file_tags_mdb_file_id_fkey FOREIGN KEY (mdb_file_id) REFERENCES public.mdb_files(id);


--
-- Name: mdb_files mdb_files_archive_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mdb_files
    ADD CONSTRAINT mdb_files_archive_batch_id_fkey FOREIGN KEY (archive_batch_id) REFERENCES public.archive_batches(id);


--
-- Name: mdb_files mdb_files_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mdb_files
    ADD CONSTRAINT mdb_files_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id);


--
-- Name: mdb_folder_placeholders mdb_folder_placeholders_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mdb_folder_placeholders
    ADD CONSTRAINT mdb_folder_placeholders_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: mdb_tag_histories mdb_tag_histories_applied_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mdb_tag_histories
    ADD CONSTRAINT mdb_tag_histories_applied_by_fkey FOREIGN KEY (applied_by) REFERENCES public.users(id);


--
-- Name: mdb_tag_histories mdb_tag_histories_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mdb_tag_histories
    ADD CONSTRAINT mdb_tag_histories_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: mdb_tag_histories mdb_tag_histories_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mdb_tag_histories
    ADD CONSTRAINT mdb_tag_histories_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id);


--
-- Name: mdb_tag_histories mdb_tag_histories_reverted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mdb_tag_histories
    ADD CONSTRAINT mdb_tag_histories_reverted_by_fkey FOREIGN KEY (reverted_by) REFERENCES public.users(id);


--
-- Name: user_favorites user_favorites_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_favorites
    ADD CONSTRAINT user_favorites_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id);


--
-- Name: user_favorites user_favorites_mdb_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_favorites
    ADD CONSTRAINT user_favorites_mdb_file_id_fkey FOREIGN KEY (mdb_file_id) REFERENCES public.mdb_files(id);


--
-- Name: user_favorites user_favorites_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_favorites
    ADD CONSTRAINT user_favorites_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: users users_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id);


--
-- PostgreSQL database dump complete
--

\unrestrict vevCOXGIR83W30lY3EqOKMdfIXU2O5I8OET1sdoRQwrHPA1K4arRvz3LaDL3EgR

