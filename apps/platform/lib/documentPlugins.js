// Document plugin registry.
//
// Keep document bodies modular: every document uses the universal letterhead
// envelope, then a profession-specific body plugin supplies only the fields
// and document types that make sense for that theme.

export const UNIVERSAL_LETTERHEAD_GROUPS = [
  {
    id: 'brand',
    label: 'Header / Brand identity',
    fields: [
      field('logo', 'Logo', 'image', { upload: true, controls: ['size', 'position'] }),
      field('organization_name', 'Organization name', 'text', { required: true }),
      field('tagline', 'Tagline', 'text'),
      field('brand_color', 'Brand colour', 'color'),
    ],
  },
  {
    id: 'address',
    label: 'Address block',
    fields: [
      field('street_address', 'Street address', 'text'),
      field('address_line_2', 'Address line 2', 'text'),
      field('city', 'City', 'text'),
      field('state', 'State / region', 'text'),
      field('zip', 'ZIP / postcode', 'text'),
      field('country', 'Country', 'text'),
      field('branch_name', 'Branch name', 'text'),
      field('branch_address', 'Branch address', 'textarea'),
    ],
  },
  {
    id: 'contact',
    label: 'Contact information',
    fields: [
      field('phone', 'Phone', 'tel'),
      field('alt_phone', 'Alternate phone', 'tel'),
      field('fax', 'Fax', 'text'),
      field('email', 'Email', 'email'),
      field('website', 'Website', 'url'),
    ],
  },
  {
    id: 'professional_ids',
    label: 'Professional / regulatory IDs',
    fields: [
      field('registration_number', 'Registration number', 'text', {
        professions: ['doctor_medical', 'lawyer_legal', 'veterinary'],
      }),
      field('license_number', 'License number', 'text', {
        professions: ['business_consultant', 'wellness_fitness'],
      }),
      field('accreditation', 'Accreditation / qualifications', 'text'),
      field('practice_type', 'Practice type', 'text'),
    ],
  },
  {
    id: 'document_meta',
    label: 'Document meta',
    fields: [
      field('document_title', 'Document title', 'text'),
      field('reference_number', 'Reference number', 'text'),
      field('date_field', 'Date', 'date'),
      field('confidentiality_label', 'Confidentiality label', 'text'),
    ],
  },
  {
    id: 'recipient',
    label: 'Recipient block',
    fields: [
      field('to_name', 'Recipient name', 'text'),
      field('to_designation', 'Recipient designation', 'text'),
      field('to_organization', 'Recipient organization', 'text'),
      field('to_address', 'Recipient address', 'textarea'),
    ],
  },
  {
    id: 'typography',
    label: 'Typography & formatting',
    fields: [
      field('primary_font', 'Primary font', 'select', {
        options: ['Georgia', 'Arial', 'Calibri', 'Times New Roman'],
      }),
      field('heading_size', 'Heading size', 'select', { options: ['small', 'medium', 'large'] }),
      field('body_font_size', 'Body font size', 'select', { options: ['10pt', '11pt', '12pt'] }),
      field('line_spacing', 'Line spacing', 'select', { options: ['single', '1.15', '1.5'] }),
      field('text_alignment', 'Text alignment', 'select', { options: ['left', 'justified'] }),
    ],
  },
  {
    id: 'body_defaults',
    label: 'Body area',
    fields: [
      field('blank_content_area', 'Content area', 'richtext'),
      field('subject_line', 'Subject line', 'text'),
      field('salutation_style', 'Salutation style', 'select', {
        options: ['Dear Sir/Madam', 'To Whom It May Concern', 'Dear client', 'Custom'],
      }),
    ],
  },
  {
    id: 'signature',
    label: 'Signature block',
    fields: [
      field('signatory_name', 'Signatory name', 'text'),
      field('signatory_title', 'Signatory title', 'text'),
      field('signature_image', 'Signature image', 'image', { upload: true }),
      field('stamp_seal_image', 'Stamp / seal image', 'image', { upload: true }),
    ],
  },
  {
    id: 'footer',
    label: 'Footer',
    fields: [
      field('disclaimer_text', 'Disclaimer text', 'textarea'),
      field('page_number', 'Page number', 'boolean'),
      field('footer_logo', 'Footer logo / badge', 'image', { upload: true }),
    ],
  },
];

export const COMMON_BODY_FIELDS = [
  field('client_name', 'Client / patient name', 'text', { token: 'customer.name' }),
  field('booking_reference', 'Booking reference', 'text', { token: 'appointment.id' }),
  field('appointment_date', 'Appointment date', 'date', { token: 'appointment.date' }),
  field('appointment_time', 'Appointment time', 'time', { token: 'appointment.startTime' }),
  field('duration', 'Duration', 'text', { token: 'service.duration' }),
  field('location', 'Location', 'text', { token: 'business.address' }),
  field('client_phone', 'Client phone', 'tel', { token: 'customer.phone' }),
  field('client_email', 'Client email', 'email', { token: 'customer.email' }),
  field('assigned_to', 'Assigned to', 'text', { token: 'staff.name' }),
  field('notes', 'Notes', 'textarea'),
  field('status', 'Status', 'select', {
    options: ['Confirmed', 'Pending', 'Rescheduled', 'Cancelled'],
  }),
];

export const DOCUMENT_BODY_PLUGINS = [
  {
    id: 'doctor_medical',
    label: 'Doctor / Medical',
    ownerLabel: 'Patient',
    assignedLabel: 'Doctor',
    themeKeys: [
      'doctor',
      'doctor_clinic',
      'general_practice',
      'general_practitioner',
      'family_doctor',
      'medical_clinic',
      'private_clinic',
      'dental',
      'dental_clinic',
      'dentist',
      'orthodontist',
      'physio',
      'physiotherapy',
      'physiotherapist',
      'sports_physio',
      'rehab_clinic',
      'psychology',
      'psychologist',
      'therapist',
      'mental_health_clinic',
      'dermatology',
      'dermatologist',
      'skin_clinic',
      'chiropractic',
      'chiropractic_clinic',
      'optometry',
      'eye_specialist',
      'nutrition',
      'dietitian',
      'nutrition_coach',
      'cardiologist',
      'gynecologist',
      'pediatrician',
      'ent_specialist',
      'diagnostic_lab',
      'radiology_centre',
      'ultrasound_clinic',
      'acupuncture_clinic',
      'ayurveda_clinic',
      'homeopathy_clinic',
      'naturopathy_clinic',
      'cosmetic_clinic',
      'anti_aging_clinic',
    ],
    documentTypes: [
      docType('prescription', 'Prescription'),
      docType('medical_certificate', 'Medical certificate'),
      docType('follow_up_note', 'Follow-up note'),
    ],
    fields: [
      field('rx_section', 'Prescription area', 'rx'),
      field('patient_age', 'Patient age', 'number'),
      field('patient_gender', 'Patient gender', 'select', { options: ['Female', 'Male', 'Other', 'Prefer not to say'] }),
      field('blood_group', 'Blood group', 'select', { options: ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] }),
      field('visit_type', 'Visit type', 'select', { options: ['First Visit', 'Follow-up', 'Emergency'] }),
      field('referring_doctor', 'Referring doctor', 'text'),
      field('diagnosis_notes', 'Diagnosis notes', 'textarea'),
    ],
  },
  {
    id: 'lawyer_legal',
    label: 'Lawyer / Legal',
    ownerLabel: 'Client',
    assignedLabel: 'Lawyer',
    themeKeys: [
      'law_firm',
      'legal',
      'lawyer',
      'business_lawyer',
      'criminal_lawyer',
      'family_lawyer',
      'property_lawyer',
      'legal_advisor',
      'immigration',
      'immigration_advisor',
      'immigration_lawyer',
      'education_visa_consultant',
      'startup_legal_consultant',
      'student_visa',
      'visa_assistance',
      'visa_consultant',
      'visitor_visa',
    ],
    documentTypes: [
      docType('engagement_letter', 'Engagement letter'),
      docType('legal_notice', 'Legal notice'),
      docType('case_note', 'Case note'),
      docType('advice_note', 'Advice note'),
    ],
    fields: [
      field('case_number', 'Case number', 'text'),
      field('matter_type', 'Matter type', 'select', { options: ['Civil', 'Family', 'Corporate', 'Immigration', 'Criminal', 'Property'] }),
      field('opposing_party', 'Opposing party', 'text'),
      field('court_date', 'Court date', 'date'),
      field('confidentiality_notice', 'Confidentiality notice', 'textarea', {
        defaultValue: 'Private & Confidential / Without Prejudice where applicable.',
      }),
    ],
  },
  {
    id: 'veterinary',
    label: 'Veterinary',
    ownerLabel: 'Owner',
    assignedLabel: 'Vet',
    themeKeys: [
      'veterinary',
      'vet_clinic',
      'pet_hospital',
      'pet_vaccination_clinic',
      'animal_care',
      'pet_care',
      'pet_shop',
    ],
    documentTypes: [
      docType('pet_prescription', 'Pet prescription'),
      docType('vaccination_certificate', 'Vaccination certificate'),
      docType('visit_summary', 'Visit summary'),
    ],
    fields: [
      field('pet_name', 'Pet name', 'text'),
      field('species', 'Species', 'select', { options: ['Dog', 'Cat', 'Bird', 'Rabbit', 'Other'] }),
      field('breed', 'Breed', 'text'),
      field('pet_age', 'Pet age', 'text'),
      field('owner_name', 'Owner name', 'text'),
      field('vaccination_status', 'Vaccination status', 'select', { options: ['Up to date', 'Due', 'Overdue', 'Unknown'] }),
      field('rx_section', 'Prescription area', 'rx'),
    ],
  },
  {
    id: 'wellness_fitness',
    label: 'Yoga / Wellness / Fitness',
    ownerLabel: 'Client',
    assignedLabel: 'Instructor',
    themeKeys: [
      'yoga',
      'yoga_studio',
      'yoga_instructor',
      'online_yoga_teacher',
      'meditation',
      'meditation_coach',
      'meditation_yoga',
      'fitness_coach',
      'fitness_trainer',
      'online_fitness_trainer',
      'fitness_program',
      'fitness_coach_personal_brand',
      'personal_trainer',
      'personal_training_studio',
      'gym',
      'gym_trainer',
      'pilates_coach',
      'pilates_studio',
      'wellness_centre',
      'massage_therapist',
      'strength_training',
      'weight_loss_coach',
    ],
    documentTypes: [
      docType('session_plan', 'Session plan'),
      docType('wellness_note', 'Wellness note'),
      docType('health_disclaimer', 'Health disclaimer'),
    ],
    fields: [
      field('session_type', 'Session type', 'text'),
      field('session_level', 'Session level', 'select', { options: ['Beginner', 'Intermediate', 'Advanced'] }),
      field('instructor', 'Instructor', 'text'),
      field('equipment_needed', 'Equipment needed', 'textarea'),
      field('health_disclaimer', 'Health disclaimer', 'textarea', {
        defaultValue: 'Please consult a qualified medical professional before starting a new health or fitness program.',
      }),
    ],
  },
  {
    id: 'business_consultant',
    label: 'General business / consultant',
    ownerLabel: 'Client',
    assignedLabel: 'Consultant',
    themeKeys: [
      'consultant',
      'business_coach',
      'accountant',
      'bookkeeping',
      'bookkeeping_firm',
      'tax_advisor',
      'tax_consultant',
      'ca_tax_consultant',
      'financial_advisor',
      'finance_consultant',
      'architect',
      'architect_studio',
      'interior_architect',
      'it_services',
      'it_consultant',
      'marketing_agency',
      'marketing_consultant',
      'startup_consultant',
      'management_consultant',
      'strategy_consultant',
      'operations_consultant',
      'hr_consultant',
      'compliance_consultant',
    ],
    documentTypes: [
      docType('meeting_agenda', 'Meeting agenda'),
      docType('service_note', 'Service note'),
      docType('proposal_summary', 'Proposal summary'),
    ],
    fields: [
      field('service_type', 'Service type', 'text'),
      field('meeting_type', 'Meeting type', 'select', { options: ['In-person', 'Video call', 'Phone'] }),
      field('meeting_link', 'Meeting link', 'url'),
      field('agenda', 'Agenda', 'bullet_list'),
    ],
  },
];

export const DEFAULT_DOCUMENT_PLUGIN_ID = 'business_consultant';

export function normalizeDocumentThemeKey(themeKey) {
  return String(themeKey || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function getDocumentPlugin(pluginId) {
  return DOCUMENT_BODY_PLUGINS.find((plugin) => plugin.id === pluginId) || null;
}

export function getDocumentPluginForTheme(themeKey) {
  const key = normalizeDocumentThemeKey(themeKey);
  return DOCUMENT_BODY_PLUGINS.find((plugin) => plugin.themeKeys.includes(key))
    || getDocumentPlugin(DEFAULT_DOCUMENT_PLUGIN_ID);
}

export function getDocumentTypesForTheme(themeKey) {
  return getDocumentPluginForTheme(themeKey)?.documentTypes || [];
}

export function getBodyFieldsForPlugin(pluginId, { includeCommon = true } = {}) {
  const plugin = getDocumentPlugin(pluginId);
  if (!plugin) return includeCommon ? [...COMMON_BODY_FIELDS] : [];
  return includeCommon ? [...COMMON_BODY_FIELDS, ...plugin.fields] : [...plugin.fields];
}

export function getLetterheadGroupsForPlugin(pluginId) {
  return UNIVERSAL_LETTERHEAD_GROUPS.map((group) => ({
    ...group,
    fields: group.fields.filter((item) => (
      !Array.isArray(item.professions) || item.professions.includes(pluginId)
    )),
  })).filter((group) => group.fields.length > 0);
}

function field(id, label, type, options = {}) {
  return {
    id,
    label,
    type,
    ...options,
  };
}

function docType(id, label) {
  return { id, label };
}
