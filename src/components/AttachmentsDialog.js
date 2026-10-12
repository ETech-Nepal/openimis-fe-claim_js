import React, { Component } from "react";
import { bindActionCreators } from "redux";
import { connect } from "react-redux";
import { injectIntl } from "react-intl";

import {
  Dialog,
  DialogTitle,
  Divider,
  Button,
  DialogActions,
  DialogContent,
  Link,
  IconButton,
  Badge,
} from "@material-ui/core";
import { withTheme, withStyles } from "@material-ui/core/styles";
import SaveIcon from "@material-ui/icons/Save";
import DeleteIcon from "@material-ui/icons/Delete";
import FileIcon from "@material-ui/icons/Add";
import LinkIcon from "@material-ui/icons/Link";
import PreviewIcon from "@material-ui/icons/Visibility";

import {
  FormattedMessage,
  withModulesManager,
  ProgressOrError,
  Table,
  TextInput,
  PublishedComponent,
  withTooltip,
  formatMessage,
  formatMessageWithValues,
  journalize,
  coreConfirm,
  coreAlert,
} from "@openimis/fe-core";
import {
  fetchClaimAttachments,
  fetchAttachmentBlob,
  downloadAttachment,
  deleteAttachment,
  createAttachment,
  updateAttachment,
} from "../actions";
import { DEFAULT, RIGHT_ADD, URL_TYPE_STRING } from "../constants";
import AttachmentGeneralTypePicker from "../pickers/AttachmentGeneralTypePicker";

const styles = (theme) => ({
  dialogTitle: theme.dialog.title,
  dialogContent: theme.dialog.content,
  viewAll: {
    display: "flex",
    gap: theme.spacing(2),
    margin: theme.spacing(1, 3),
    justifyContent: "center",
    flexWrap: "wrap",
  },
});

const VIEWER_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Attachment viewer</title>
<style>
  body { margin: 0; font-family: Arial, sans-serif; display: flex; flex-direction: column; height: 100vh; background: #f5f5f5; }
  .header { background: #1976d2; color: white; padding: 10px 20px; display: flex; justify-content: space-between; align-items: center; gap: 16px; }
  .meta { min-width: 0; }
  .meta .name { font-weight: bold; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta .sub { font-size: 12px; opacity: .9; }
  .controls { display: flex; gap: 8px; align-items: center; flex-shrink: 0; }
  .group { display: flex; gap: 4px; align-items: center; background: rgba(255,255,255,.15); padding: 4px 8px; border-radius: 4px; }
  .group .label { font-size: 12px; margin: 0 4px; white-space: nowrap; }
  button, a.button { padding: 6px 12px; background: white; color: #1976d2; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; text-decoration: none; }
  button:disabled { opacity: .4; cursor: not-allowed; }
  #stage { flex: 1; min-height: 0; display: flex; }
  iframe, img { flex: 1; min-height: 0; width: 100%; border: none; background: white; }
  img { object-fit: contain; }
  .message { margin: auto; text-align: center; color: #555; }
  .message p { margin-bottom: 16px; }
</style>
</head>
<body>
<div class="header">
  <div class="meta"><div class="name" id="fname"></div><div class="sub" id="fsub"></div></div>
  <div class="controls">
    <span class="group" id="pageGroup">
      <button id="prevPage">&#8249; Page</button><span class="label" id="pageLabel"></span><button id="nextPage">Page &#8250;</button>
    </span>
    <span class="group" id="fileGroup">
      <button id="prevFile">&#8249; File</button><span class="label" id="fileLabel"></span><button id="nextFile">File &#8250;</button>
    </span>
    <button id="closeBtn">Close</button>
  </div>
</div>
<div id="stage"></div>
</body>
</html>`;

// Mime from the file's magic bytes: the stored mime can be empty or wrong.
function sniffMime(bytes) {
  const starts = (...sig) => sig.every((b, i) => bytes[i] === b);
  if (starts(0x25, 0x50, 0x44, 0x46)) return "application/pdf";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x42, 0x4d)) return "image/bmp";
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45) return "image/webp";
  return null;
}

function base64ToBytes(b64) {
  const bin = atob(String(b64).replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Page count read from the PDF's page tree (/Type /Pages ... /Count N), without pdf.js.
// 0 means unknown (e.g. the tree sits in a compressed object stream): paging is then unbounded.
function pdfPageCount(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  let max = 0;
  const re = /\/Type\s*\/Pages\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const c = /\/Count\s+(\d+)/.exec(text.slice(Math.max(0, m.index - 300), m.index + 300));
    if (c) max = Math.max(max, parseInt(c[1], 10));
  }
  if (max > 0) return max;
  const singles = text.match(/\/Type\s*\/Page[^s]/g);
  return singles ? singles.length : 0;
}

class AttachmentsDialog extends Component {
  constructor(props) {
    super(props);
    this.allowedDomainsAttachments = props.modulesManager.getConf(
      "fe-claim",
      "allowedDomainsAttachments",
      DEFAULT.ALLOWED_DOMAINS_ATTACHMENTS,
    );
  }

  state = {
    open: false,
    claimUuid: null,
    claimAttachments: [],
    attachmentToDelete: null,
    updatedAttachments: new Set(),
    reset: 0,
  };

  componentDidUpdate(prevProps, props, snapshot) {
    const { readOnly = false } = this.props;
    if (!_.isEqual(prevProps.claimAttachments, this.props.claimAttachments)) {
      var claimAttachments = [...(this.props.claimAttachments || [])];
      if (!this.props.readOnly && this.props.rights.includes(RIGHT_ADD) && !this.isEmptyAttachment(_.last(claimAttachments))) {
        claimAttachments.push({});
      }
      this.setState({ claimAttachments, updatedAttachments: new Set() });
    } 
    else if (
      !_.isEqual(prevProps.claim, this.props.claim) &&
      !!this.props.claim &&
      !!this.props.claim.uuid
    ) {
      this.setState(
        (state, props) => ({
          open: true,
          claimUuid: props.claim.uuid,
          claimAttachments: props.claim.attachments || [],
          updatedAttachments: new Set(),
        }),
        async () => {
          if (!!this.props.claim && !!this.props.claim.uuid) {
            try {
              const serverAttachments = await this.props.fetchClaimAttachments(this.props.claim);
    
              // 1. Retrieving server data
              const edges = serverAttachments?.payload?.data?.claimAttachments?.edges || [];
              const serverList = edges.map((e) => e.node);
    
              // 2. Retrieving local data
              const localList = this.props.claim.attachments || [];
    
              // 3. Merge: we keep all unique elements (by id if present, otherwise by filename)
              const merged = [...serverList];
              localList.forEach((loc) => {
                const alreadyExists = merged.some(
                  (srv) => srv.id === loc.id || (srv.filename && srv.filename === loc.filename)
                );
                if (!alreadyExists) {
                  merged.push(loc);
                }
              });
    
              // 4. Add empty line if in edit mode
              if (!readOnly && (merged.length === 0 || !this.isEmptyAttachment(_.last(merged)))) {
                merged.push({});
              }
    
              // 5. Updating state
              this.setState({
                claimAttachments: merged,
                updatedAttachments: new Set(),
              });
            } catch (err) {
              console.error("Error fetchClaimAttachments", err);
            }
          }
        }
      );
    } else if (!_.isEqual(prevProps.claim, this.props.claim) && !!this.props.claim && !this.props.claim.uuid) {
      let claimAttachments = [...(this.props.claim.attachments || [])];
      if (!readOnly) {
        if (claimAttachments.length === 0) {
          claimAttachments.push({});
          this.props.onUpdated();
        } else if (!this.isEmptyAttachment(_.last(claimAttachments))) {
          claimAttachments.push({});
          this.props.onUpdated();
        }
      }
      this.setState({ open: true, claimUuid: null, claimAttachments, updatedAttachments: new Set() });
    } else if (prevProps.submittingMutation && !this.props.submittingMutation) {
      var claimAttachments = [...this.state.claimAttachments];
      if (!!this.state.attachmentToDelete) {
        claimAttachments = claimAttachments.filter((a) => a.id !== this.state.attachmentToDelete.id);
      } else if (!this.isEmptyAttachment(_.last(claimAttachments))) {
        claimAttachments.push({});
      }
      this.setState((state) => ({
        claimAttachments,
        updatedAttachments: new Set(),
        attachmentToDelete: null,
        reset: state.reset + 1,
      }));
    } else if (
      prevProps.confirmed !== this.props.confirmed &&
      !!this.props.confirmed &&
      !!this.state.attachmentToDelete
    ) {
      const title = this.state.attachmentToDelete.title ? `${this.state.attachmentToDelete.title}` : "";
      const filename = this.state.attachmentToDelete.filename ? `(${this.state.attachmentToDelete.filename})` : "";
      this.props.deleteAttachment(
        this.state.attachmentToDelete,
        formatMessageWithValues(this.props.intl, "claim", "claim.ClaimAttachment.delete.mutationLabel", {
          file: `${title} ${filename}`,
          code: `${this.props.claim.code}`,
        }),
      );
      
    }
  }

  onClose = () => {
    this.setState({ open: false }, (e) => !!this.props.close && this.props.close())
  };

  validateUrl(url, omitValidation = false) {
    let parsedUrl;

    if (omitValidation) {
      return { isValid: true, error: null };
    }

    try {
      parsedUrl = new URL(url);
    } catch (error) {
      return { isValid: false, error: "url.validation.invalidURL" };
    }

    if (this.allowedDomainsAttachments.length === 0) {
      return { isValid: true, error: null };
    }

    const enteredDomain = parsedUrl.hostname;
    const isDomainAllowed = this.allowedDomainsAttachments.some((allowedDomain) =>
      enteredDomain.endsWith(allowedDomain),
    );

    if (!isDomainAllowed) {
      return { isValid: false, error: "url.validation.notAllowed" };
    }

    return { isValid: true, error: null };
  }

  delete = (a, i) => {
    if (!!a.id) {
      const filename = a.filename ? `(${a.filename})` : "";
      this.setState({ attachmentToDelete: a }, (e) =>
        this.props.coreConfirm(
          formatMessage(this.props.intl, "claim", "deleteClaimAttachment.confirm.title"),
          formatMessageWithValues(this.props.intl, "claim", "deleteClaimAttachment.confirm.message", {
            file: `${a.title} ${filename}`,
          }),
        ),
      );
    } else {
      var claimAttachments = [...this.state.claimAttachments];
      claimAttachments.splice(i, 1);
      claimAttachments.pop();
      this.props.claim.attachments = [...claimAttachments];
      this.props.claim.attachmentsCount =
        this.props.claim.attachments.length > 0 ? this.props.claim.attachments.length : 0;
      claimAttachments.push({});
      this.props.onUpdated();
      this.setState((state) => ({ claimAttachments, reset: state.reset + 1 }));
    }
  };

  addAttachment = (document, index) => {
    let attachment = this.state.claimAttachments[index];
    attachment.document = document;
    if (!this.props.claim.attachments) {
      this.props.claim.attachments = [];
    }
    this.props.claim.attachments[index] = attachment;

    if (!!this.state.claimUuid) {
      const filename = attachment.filename ? `(${attachment.filename})` : "";
      this.props
        .createAttachment(
          { ...attachment, claimUuid: this.state.claimUuid },
          formatMessageWithValues(this.props.intl, "claim", "claim.ClaimAttachment.create.mutationLabel", {
            file: `${attachment.title || ""} ${filename}`,
            code: `${this.props.claim.code}`,
          }),
        )
    } 
    // if we are in add mode and the last line is filled, we add a new line
    const canAdd = !this.props.readOnly && this.props.rights && this.props.rights.includes(RIGHT_ADD);
    const last = this.state.claimAttachments[this.state.claimAttachments.length - 1];
    const lastIsEmpty = last && Object.keys(last).length === 0;
    this.props.claim.attachmentsCount  = this.state.claimAttachments.length;
    if (canAdd && !lastIsEmpty) {
      this.setState({ claimAttachments: [...this.state.claimAttachments, {}] });
    }
    this.props.onUpdated();
  };  
  
  update = (i) => {
    let attachment = { claimUuid: this.state.claimUuid, ...this.state.claimAttachments[i] };
    const filename = attachment.filename ? `(${attachment.filename})` : "";
    this.props.updateAttachment(
      attachment,
      formatMessageWithValues(this.props.intl, "claim", "claim.ClaimAttachment.update.mutationLabel", {
        file: `${attachment.title || ""} ${filename}`,
        code: `${this.props.claim.code}`,
      }),
    );
  };

  download = (a) => {
    this.props.downloadAttachment(a);
  };

  isPreviewable = (a) =>
    !!a && !!a.filename && !a.url && a.generalType !== URL_TYPE_STRING && (!!a.id || !!a.document);

  // Saved attachments come from /claim/attach; ones not saved yet (new claim) carry their base64 document.
  loadPreview = async (a) => {
    const bytes = a.document
      ? base64ToBytes(a.document)
      : new Uint8Array(await (await fetchAttachmentBlob(a)).arrayBuffer());
    const mime = sniffMime(bytes) || a.mime || "application/octet-stream";
    return {
      url: URL.createObjectURL(new Blob([bytes], { type: mime })),
      mime,
      pages: mime === "application/pdf" ? pdfPageCount(bytes) : 1,
    };
  };

  // Opens a popup that pages through the given attachments (and through the pages of a PDF).
  // The popup is opened synchronously, before anything is fetched, so popup blockers allow it.
  openViewer = (attachments, startIndex = 0) => {
    if (!attachments.length) return;
    const { intl } = this.props;
    const popup = window.open("", "_blank", "width=900,height=700,resizable,scrollbars");
    if (!popup) {
      this.props.coreAlert(
        formatMessage(intl, "claim", "claim.attachment.viewer.blocked.title"),
        formatMessage(intl, "claim", "claim.attachment.viewer.blocked.message"),
      );
      return;
    }
    popup.document.open();
    popup.document.write(VIEWER_HTML);
    popup.document.close();

    const $ = (id) => popup.document.getElementById(id);
    const previews = {}; // index -> Promise of { url, mime, pages }
    const load = (i) => (previews[i] = previews[i] || this.loadPreview(attachments[i]));
    let fileIndex = startIndex;
    let pageIndex = 1;

    const message = (text, a, preview) => {
      const box = popup.document.createElement("div");
      box.className = "message";
      const p = popup.document.createElement("p");
      p.textContent = text;
      box.appendChild(p);
      if (preview) {
        const link = popup.document.createElement("a");
        link.className = "button";
        link.href = preview.url;
        link.download = a.filename || "attachment";
        link.textContent = formatMessage(intl, "claim", "claim.attachment.viewer.download");
        box.appendChild(link);
      }
      return box;
    };

    const render = async () => {
      const i = fileIndex;
      const a = attachments[i];
      $("fname").textContent = a.title ? `${a.title} (${a.filename})` : a.filename;
      $("fsub").textContent = [a.type, a.date].filter(Boolean).join(" · ");
      popup.document.title = a.filename || "Attachment";
      $("fileGroup").style.display = attachments.length > 1 ? "flex" : "none";
      $("fileLabel").textContent = `${i + 1}/${attachments.length}`;
      $("prevFile").disabled = i === 0;
      $("nextFile").disabled = i === attachments.length - 1;
      $("pageGroup").style.display = "none";
      const stage = $("stage");
      stage.replaceChildren(message(formatMessage(intl, "claim", "claim.attachment.viewer.loading")));

      let preview;
      try {
        preview = await load(i);
      } catch (e) {
        if (i === fileIndex) {
          delete previews[i];
          stage.replaceChildren(message(formatMessage(intl, "claim", "claim.attachment.viewer.error")));
        }
        return;
      }
      if (i !== fileIndex || popup.closed) return; // the user moved on while it loaded

      const { pages } = preview;
      if (pageIndex < 1) pageIndex = 1;
      if (pages > 0 && pageIndex > pages) pageIndex = pages;
      const isPdf = preview.mime === "application/pdf";
      $("pageGroup").style.display = isPdf && pages !== 1 ? "flex" : "none";
      $("pageLabel").textContent = pages > 0 ? `${pageIndex}/${pages}` : `${pageIndex}`;
      $("prevPage").disabled = pageIndex <= 1;
      $("nextPage").disabled = pages > 0 && pageIndex >= pages;

      if (preview.mime.startsWith("image/")) {
        const img = popup.document.createElement("img");
        img.src = preview.url;
        stage.replaceChildren(img);
      } else if (isPdf || preview.mime.startsWith("text/")) {
        const frame = popup.document.createElement("iframe");
        // #page=N is understood by the built-in PDF viewers of Chrome and Firefox
        frame.src = isPdf && pages !== 1 ? `${preview.url}#page=${pageIndex}` : preview.url;
        stage.replaceChildren(frame);
      } else {
        stage.replaceChildren(message(formatMessage(intl, "claim", "claim.attachment.viewer.noPreview"), a, preview));
      }
    };

    const goPage = (delta) => {
      pageIndex += delta;
      render();
    };
    const goFile = (delta) => {
      const next = fileIndex + delta;
      if (next < 0 || next >= attachments.length) return;
      fileIndex = next;
      pageIndex = 1;
      render();
    };
    $("prevPage").onclick = () => goPage(-1);
    $("nextPage").onclick = () => goPage(1);
    $("prevFile").onclick = () => goFile(-1);
    $("nextFile").onclick = () => goFile(1);
    $("closeBtn").onclick = () => popup.close();
    popup.document.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight") goFile(1);
      else if (e.key === "ArrowLeft") goFile(-1);
      else if (e.key === "PageDown") goPage(1);
      else if (e.key === "PageUp") goPage(-1);
      else if (e.key === "Escape") popup.close();
    });
    // Free the blob URLs when the viewer goes away
    popup.addEventListener("pagehide", () =>
      Object.values(previews).forEach((p) => p.then((pv) => URL.revokeObjectURL(pv.url), () => null)),
    );

    render();
  };

  preview = (attachment) => {
    const viewable = this.state.claimAttachments.filter(this.isPreviewable);
    this.openViewer(viewable, Math.max(0, viewable.indexOf(attachment)));
  };

  fileSelected = (f, i) => {
    if (!!f.target.files) {
      const file = f.target.files[0];
      let claimAttachments = [...this.state.claimAttachments];
      claimAttachments[i].filename = file.name;
      claimAttachments[i].mime = file.type;
      this.setState({ claimAttachments }, (e) => {
        var reader = new FileReader();
        reader.onloadend = (loaded) => {
          this.addAttachment(btoa(loaded.target.result), i);
        };
        reader.readAsBinaryString(file);
      });
    }
  };

  formatFileName(a, i) {
    if (!!a.id)
      return (
        <Link onClick={(e) => this.download(a)} reset={this.state.reset}>
          {a.filename || ""}
        </Link>
      );
  
    if (!!a.filename) return <i>{a.filename}</i>;
  
    const missingRequiredFields =
      !this.state.claimAttachments[i].generalType || !this.state.claimAttachments[i].predefinedType;
  
    return (
      <IconButton
        variant="contained"
        component="label"
        onClick={(e) => {
          if (missingRequiredFields) {
            this.props.coreAlert(
              formatMessage(this.props.intl, "claim", "claim.attachment.missingPredefinedType"),
              formatMessage(this.props.intl, "claim", "claim.attachment.definePredefinedType")
            );
            e.preventDefault();
            return;
          }
        }}
      >
        <FileIcon color={missingRequiredFields ? "disabled" : "primary"} />
        <input
          type="file"
          style={{ display: "none" }}
          onChange={(f) => this.fileSelected(f, i)}
        />
      </IconButton>
    );
  }
  

  urlSelected = (f, i, autogeneratedUrl) => {
    const { coreAlert, intl } = this.props;
    const url = this.validateUrl(f, autogeneratedUrl);
    if (!url.isValid) {
      coreAlert(
        formatMessage(intl, "claim", "url.validation.error"),
        url.error
          ? formatMessage(intl, "claim", url.error)
          : formatMessage(intl, "claim", "url.validation.generalError"),
      );
      return;
    }

    if (!!f || autogeneratedUrl) {
      let claimAttachments = [...this.state.claimAttachments];
      claimAttachments[i].url = autogeneratedUrl ? "AUTO" : f;
      claimAttachments[i].mime = "text/x-uri";
      this.setState({ claimAttachments }, (e) => {
        this.addAttachment(f, i);
      });
    }
  };

  formatUrl(a, i) {
    const { claimAttachments, reset } = this.state;
    const autogeneratedUrl =
      claimAttachments[i].generalType === URL_TYPE_STRING && claimAttachments[i].predefinedType?.isAutogenerated;

    if (!!a.mime) {
      return (
        <Link onClick={() => window.open(a.url)} reset={reset}>
          {withTooltip(<LinkIcon />, a.url)}
        </Link>
      );
    }
    return (
      <div style={{ display: "flex", flexDirection: "row", alignItems: "center" }}>
        {!autogeneratedUrl && (
          <TextInput
            reset={reset}
            value={claimAttachments[i].url}
            onChange={(v) => this.updateAttachment(i, "url", v)}
          />
        )}
        <IconButton
          variant="contained"
          component="label"
          onClick={(f) => this.urlSelected(claimAttachments[i].url, i, autogeneratedUrl)}
        >
          <FileIcon />
        </IconButton>
      </div>
    );
  }

  updateAttachment = (i, key, value) => {
    var state = { ...this.state };
    state.claimAttachments[i][key] = value;
    state.updatedAttachments.add(i);
    state.reset = state.reset + 1;
    this.setState({ ...state });
    // reflect on props.claim.attachments
    if (!Array.isArray(this.props.claim.attachments)) {
      this.props.claim.attachments = [];
    }
    this.props.claim.attachments[i] = state.claimAttachments[i];
    if (typeof this.props.onUpdated === "function") {
      this.props.onUpdated();
    }
  };

  cannotUpdate = (a, i) => {
    // condition for locking a line
    return false;
  };

  // condition for locking fields other than generalType and predefinedType
  disableOtherFields(index) {
    return !!this.state.claimUuid &&
    (!this.state.claimAttachments[index].generalType || !this.state.claimAttachments[index].predefinedType);
  }

  isEmptyAttachment = (att) => {
    if (!att) return true;
    return Object.values(att).every(v => v === undefined || v === null || v === "");
  };
  
  
  render() {
    const { classes, claim, readOnly = false, fetchingClaimAttachments, errorClaimAttachments } = this.props;
    const { open, claimAttachments, reset, updatedAttachments } = this.state;

    if (!claim) return null;

    const headers = [
      "claimAttachment.generalType",
      "claimAttachment.predefinedType",
      "claimAttachment.type",
      "claimAttachment.title",
      "claimAttachment.date",
      "claimAttachment.fileName",
    ];

    const itemFormatters = [
      (attachment, index) =>
        this.cannotUpdate(attachment, index) ? (
          claimAttachments[index].generalType
        ) : (
          <AttachmentGeneralTypePicker
            error={!claimAttachments[index].generalType}
            helperText={"this field is required"}
            readOnly={claimAttachments[index].id}
            reset={reset}
            withNull={false}
            value={claimAttachments[index].generalType}
            onChange={(v) => this.updateAttachment(index, "generalType", v)}
          />
        ),
      (attachment, index) =>
        this.cannotUpdate(attachment, index) ? (
          claimAttachments[index].predefinedType?.claimAttachmentType ?? ""
        ) : (
          <PublishedComponent
            fieldError={!claimAttachments[index].predefinedType && !!claimAttachments[index].generalType}
            helperText={"this field is required"}
            pubRef="claim.ClaimAttachmentPredefinedTypePicker"
            label="ClaimAttachmentPredefinedType"
            value={claimAttachments[index].predefinedType}
            module="claim"
            reset={reset}
            withLabel={false}
            withPlaceholder={false}
            readOnly={readOnly || !claimAttachments[index].generalType || claimAttachments[index].id}
            withNull={false}
            claimGeneralType={claimAttachments[index].generalType}
            required={true}
            onChange={(v) => this.updateAttachment(index, "predefinedType", v)}
          />
        ),
      (attachment, index) =>
        this.cannotUpdate(attachment, index) ? (
          claimAttachments[index].type
        ) : (
          <TextInput
            reset={reset}
            readOnly={readOnly}
            value={claimAttachments[index].type}
            onChange={(v) => this.updateAttachment(index, "type", v)}
          />
        ),
      (attachment, index) =>
        this.cannotUpdate(attachment, index) ? (
          claimAttachments[index].title
        ) : (
          <TextInput
            reset={reset}
            readOnly={readOnly}
            value={claimAttachments[index].title}
            onChange={(v) => this.updateAttachment(index, "title", v)}
          />
        ),
      (attachment, index) =>
        this.cannotUpdate(attachment, index) ? (
          claimAttachments[index].date
        ) : (
          <PublishedComponent
            pubRef="core.DatePicker"
            readOnly={readOnly}
            onChange={(v) => this.updateAttachment(index, "date", v)}
            value={claimAttachments[index].date || null}
            reset={reset}
          />
        ),
      (attachment, index) =>
        claimAttachments[index].url || claimAttachments[index].generalType === URL_TYPE_STRING
          ? this.formatUrl(attachment, index)
          : this.formatFileName(attachment, index),
    ];

    headers.push("claimAttachment.action");
    itemFormatters.push((attachment, index) => {
      if (!readOnly && attachment.id && updatedAttachments.has(index)) {
        return (
          <IconButton onClick={(e) => this.update(index)}>
            <SaveIcon />
          </IconButton>
        );
      }
      const showPreview = this.isPreviewable(attachment);
      const showDelete = !readOnly && index < claimAttachments.length - 1;
      if (!showPreview && !showDelete) return null;
      return (
        <div style={{ display: "flex", alignItems: "center" }}>
          {showPreview &&
            withTooltip(
              <IconButton onClick={(e) => this.preview(attachment)}>
                <PreviewIcon />
              </IconButton>,
              formatMessage(this.props.intl, "claim", "claim.attachment.preview"),
            )}
          {showDelete && (
            <IconButton onClick={(e) => this.delete(attachment, index)}>
              <DeleteIcon />
            </IconButton>
          )}
        </div>
      );
    });

    // "View all" plus one button per attachment type (Prescription, Lab report, ...)
    const viewable = claimAttachments.filter(this.isPreviewable);
    const types = [...new Set(viewable.map((a) => (a.type || "").trim()).filter(Boolean))].sort();
    const viewGroups = viewable.length
      ? [
          { key: "all", label: formatMessage(this.props.intl, "claim", "claim.attachment.viewAll"), items: viewable },
          ...(types.length > 1 || viewable.some((a) => !(a.type || "").trim())
            ? types.map((t) => ({ key: t, label: t, items: viewable.filter((a) => (a.type || "").trim() === t) }))
            : []),
        ]
      : [];

    return (
      <Dialog
        open={open}
        fullWidth={true}
        PaperProps={{
          style: {
            width: "800px",
            maxWidth: "none",
          },
        }}
      >
        <DialogTitle className={classes.dialogTitle}>
          <FormattedMessage module="claim" id="attachments.title" values={{ code: claim.code }} />
        </DialogTitle>
        <Divider />
        <DialogContent className={classes.dialogContent}>
          <ProgressOrError progress={fetchingClaimAttachments} error={errorClaimAttachments} />
          {!fetchingClaimAttachments && !errorClaimAttachments && (
            <Table module="claim" items={claimAttachments} headers={headers} itemFormatters={itemFormatters} />
          )}
        </DialogContent>
        {!fetchingClaimAttachments && !errorClaimAttachments && viewGroups.length > 0 && (
          <div className={classes.viewAll}>
            {viewGroups.map((g) => (
              <Badge key={g.key} badgeContent={g.items.length} color="primary">
                <Button variant="outlined" color="primary" startIcon={<PreviewIcon />} onClick={() => this.openViewer(g.items)}>
                  {g.label}
                </Button>
              </Badge>
            ))}
          </div>
        )}
        <DialogActions>
          <Button onClick={this.onClose} variant="contained" color="primary">
            <FormattedMessage module="claim" id="close" />
          </Button>
        </DialogActions>
      </Dialog>
    );
  }
}

const mapStateToProps = (state) => ({
  rights: !!state.core && !!state.core.user && !!state.core.user.i_user ? state.core.user.i_user.rights : [],
  confirmed: state.core.confirmed,
  submittingMutation: state.claim.submittingMutation,
  mutation: state.claim.mutation,
  fetchingClaimAttachments: state.claim.fetchingClaimAttachments,
  fetchedClaimAttachments: state.claim.fetchedClaimAttachments,
  errorClaimAttachments: state.claim.errorClaimAttachments,
  claimAttachments: state.claim.claimAttachments,
});

const mapDispatchToProps = (dispatch) => {
  return bindActionCreators(
    {
      fetchClaimAttachments,
      downloadAttachment,
      deleteAttachment,
      createAttachment,
      updateAttachment,
      coreConfirm,
      journalize,
      coreAlert,
    },
    dispatch,
  );
};

export default withModulesManager(
  connect(mapStateToProps, mapDispatchToProps)(injectIntl(withTheme(withStyles(styles)(AttachmentsDialog)))),
);